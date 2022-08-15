import {
  BoundsUtils,
  getSizeFromSrc,
  TLAsset,
  TLBinding,
  TLShapeModel,
  uniqueId,
  validUUID,
} from '@tldraw/core'
import type { TLReactCallbacks } from '@tldraw/react'
import * as React from 'react'
import { NIL as NIL_UUID } from 'uuid'
import { HTMLShape, LogseqPortalShape, Shape, YouTubeShape } from '~lib'
import type { LogseqContextValue } from '~lib/logseq-context'

const isValidURL = (url: string) => {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export function usePaste(context: LogseqContextValue) {
  const { handlers } = context

  return React.useCallback<TLReactCallbacks<Shape>['onPaste']>(
    async (app, { point, shiftKey, files }) => {
      const assetId = uniqueId()
      interface ImageAsset extends TLAsset {
        size: number[]
      }

      const assetsToCreate: ImageAsset[] = []
      const shapesToCreate: Shape['props'][] = []
      const bindingsToCreate: TLBinding[] = []

      async function createAsset(file: File): Promise<string | null> {
        return await handlers.saveAsset(file)
      }

      // TODO: handle PDF?
      async function handleFiles(files: File[]) {
        const IMAGE_EXTENSIONS = ['.png', '.svg', '.jpg', '.jpeg', '.gif']

        for (const file of files) {
          // Get extension, verify that it's an image
          const extensionMatch = file.name.match(/\.[0-9a-z]+$/i)
          if (!extensionMatch) {
            continue
          }
          const extension = extensionMatch[0].toLowerCase()
          if (!IMAGE_EXTENSIONS.includes(extension)) {
            continue
          }
          try {
            // Turn the image into a base64 dataurl
            const dataurl = await createAsset(file)
            if (!dataurl) {
              continue
            }
            // Do we already have an asset for this image?
            const existingAsset = Object.values(app.assets).find(asset => asset.src === dataurl)
            if (existingAsset) {
              assetsToCreate.push(existingAsset as ImageAsset)
              continue
            }
            // Create a new asset for this image
            const asset: ImageAsset = {
              id: assetId,
              type: 'image',
              src: dataurl,
              size: await getSizeFromSrc(handlers.makeAssetUrl(dataurl)),
            }
            assetsToCreate.push(asset)
          } catch (error) {
            console.error(error)
          }
        }
      }

      async function handleHTML(item: ClipboardItem) {
        if (item.types.includes('text/html')) {
          const blob = await item.getType('text/html')
          const rawText = (await blob.text()).trim()

          shapesToCreate.push({
            ...HTMLShape.defaultProps,
            html: rawText,
            point: [point[0], point[1]],
          })
          return true
        }
        return false
      }

      async function handleTextPlain(item: ClipboardItem) {
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain')
          const rawText = (await blob.text()).trim()

          if (handleURL(rawText)) {
            return true
          }

          if (handleIframe(rawText)) {
            return true
          }

          if (handleTldrawShapes(rawText)) {
            return true
          }
          if (await handleLogseqPortalShapes(rawText)) {
            return true
          }
        }

        return false
      }

      function handleTldrawShapes(rawText: string) {
        try {
          const data = JSON.parse(rawText)
          if (data.type === 'logseq/whiteboard-shapes') {
            debugger
            const shapes = data.shapes as TLShapeModel[]
            const commonBounds = BoundsUtils.getCommonBounds(
              shapes.map(shape => ({
                minX: shape.point?.[0] ?? point[0],
                minY: shape.point?.[1] ?? point[1],
                width: shape.size?.[0] ?? 4,
                height: shape.size?.[1] ?? 4,
                maxX: (shape.point?.[0] ?? point[0]) + (shape.size?.[0] ?? 4),
                maxY: (shape.point?.[1] ?? point[1]) + (shape.size?.[1] ?? 4),
              }))
            )
            const clonedShapes = shapes.map(shape => {
              return {
                ...shape,
                point: [
                  point[0] + shape.point![0] - commonBounds.minX,
                  point[1] + shape.point![1] - commonBounds.minY,
                ],
              }
            })
            // @ts-expect-error - This is a valid shape
            shapesToCreate.push(...clonedShapes)

            // Try to rebinding the shapes to the new assets
            shapesToCreate.forEach((s, idx) => {
              if (s.handles) {
                Object.values(s.handles).forEach(h => {
                  if (h.bindingId) {
                    // try to bind the new shape
                    const binding = app.currentPage.bindings[h.bindingId]
                    // FIXME: if copy from a different whiteboard, the binding info
                    // will not be available
                    if (binding) {
                      // if the copied binding from/to is in the source
                      const oldFromIdx = shapes.findIndex(s => s.id === binding.fromId)
                      const oldToIdx = shapes.findIndex(s => s.id === binding.toId)
                      if (binding && oldFromIdx !== -1 && oldToIdx !== -1) {
                        const newBinding: TLBinding = {
                          ...binding,
                          id: uniqueId(),
                          fromId: shapesToCreate[oldFromIdx].id,
                          toId: shapesToCreate[oldToIdx].id,
                        }
                        bindingsToCreate.push(newBinding)
                        h.bindingId = newBinding.id
                      } else {
                        h.bindingId = undefined
                      }
                    }
                  }
                })
              }
            })
            return true
          }
        } catch (err) {
          console.error(err)
        }
        return false
      }

      function handleURL(rawText: string) {
        if (isValidURL(rawText)) {
          const getYoutubeId = (url: string) => {
            const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#&?]*).*/)
            return match && match[2].length === 11 ? match[2] : null
          }
          const youtubeId = getYoutubeId(rawText)
          if (youtubeId) {
            shapesToCreate.push({
              ...YouTubeShape.defaultProps,
              embedId: youtubeId,
              point: [point[0], point[1]],
            })
            return true
          }
          // ??? deal with normal URLs?
        }
        return false
      }

      function handleIframe(rawText: string) {
        // if rawText is iframe text
        if (rawText.startsWith('<iframe')) {
          shapesToCreate.push({
            ...HTMLShape.defaultProps,
            html: rawText,
            point: [point[0], point[1]],
          })
          return true
        }
        return false
      }

      async function handleLogseqPortalShapes(rawText: string) {
        if (/^\(\(.*\)\)$/.test(rawText) && rawText.length === NIL_UUID.length + 4) {
          const blockRef = rawText.slice(2, -2)
          if (validUUID(blockRef)) {
            shapesToCreate.push({
              ...LogseqPortalShape.defaultProps,
              point: [point[0], point[1]],
              size: [400, 0], // use 0 here to enable auto-resize
              pageId: blockRef,
              blockType: 'B',
            })
            return true
          }
        } else if (/^\[\[.*\]\]$/.test(rawText)) {
          const pageName = rawText.slice(2, -2)
          shapesToCreate.push({
            ...LogseqPortalShape.defaultProps,
            point: [point[0], point[1]],
            size: [400, 0], // use 0 here to enable auto-resize
            pageId: pageName,
            blockType: 'P',
          })
          return true
        }

        const uuid = handlers?.addNewBlock(rawText)
        if (uuid) {
          // create text shape
          shapesToCreate.push({
            ...LogseqPortalShape.defaultProps,
            id: uniqueId(),
            size: [400, 0], // use 0 here to enable auto-resize
            point: [point[0], point[1]],
            pageId: uuid,
            blockType: 'B',
            compact: true,
          })
          return true
        }
        return false
      }

      try {
        if (files && files.length > 0) {
          await handleFiles(files)
        } else {
          for (const item of await navigator.clipboard.read()) {
            let handled = !shiftKey ? await handleHTML(item) : false
            if (!handled) {
              await handleTextPlain(item)
            }
          }
        }
      } catch (error) {
        console.error(error)
      }

      const allShapesToAdd: TLShapeModel[] = [
        // assets to images
        ...assetsToCreate.map((asset, i) => ({
          type: 'image',
          // TODO: Should be place near the last edited shape
          point: [point[0] - asset.size[0] / 2 + i * 16, point[1] - asset.size[1] / 2 + i * 16],
          size: asset.size,
          assetId: asset.id,
          opacity: 1,
        })),
        ...shapesToCreate,
      ].map(shape => {
        return {
          ...shape,
          parentId: app.currentPageId,
          id: uniqueId(),
        }
      })

      app.wrapUpdate(() => {
        if (assetsToCreate.length > 0) {
          app.createAssets(assetsToCreate)
        }
        if (allShapesToAdd.length > 0) {
          app.createShapes(allShapesToAdd)
        }
        app.currentPage.updateBindings(Object.fromEntries(bindingsToCreate.map(b => [b.id, b])))
        app.setSelectedShapes(allShapesToAdd.map(s => s.id))
      })
    },
    []
  )
}
