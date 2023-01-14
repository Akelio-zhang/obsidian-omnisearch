import { Notice } from 'obsidian'
import {
  type DocumentRef,
  getTextExtractor,
  type IndexedDocument,
} from './globals'
import { database } from './database'
import {
  extractHeadingsFromCache,
  getAliasesFromMetadata,
  getTagsFromMetadata,
  isFileCanvas,
  isFileImage,
  isFilePDF,
  isFilePlaintext,
  makeMD5,
  removeDiacritics,
} from './tools/utils'
import { getImageText, getPdfText } from 'obsidian-text-extract'
import type { CanvasData } from 'obsidian/canvas'
import type { AsPlainObject } from 'minisearch'
import type MiniSearch from 'minisearch'

/**
 * This function is responsible for extracting the text from a file and
 * returning it as an `IndexedDocument` object.
 * @param path
 */
async function getAndMapIndexedDocument(
  path: string
): Promise<IndexedDocument> {
  const file = app.vault.getFiles().find(f => f.path === path)
  if (!file) throw new Error(`Invalid file path: "${path}"`)
  let content: string | null = null

  const extractor = getTextExtractor()

  // ** Plain text **
  // Just read the file content
  if (isFilePlaintext(path)) {
    content = await app.vault.cachedRead(file)
  }

  // ** Canvas **
  // Extract the text fields from the json
  else if (isFileCanvas(path)) {
    const canvas = JSON.parse(await app.vault.cachedRead(file)) as CanvasData
    let texts: string[] = []
    // Concatenate text from the canvas fields
    for (const node of canvas.nodes) {
      if (node.type === 'text') {
        texts.push(node.text)
      } else if (node.type === 'file') {
        texts.push(node.file)
      }
    }
    for (const edge of canvas.edges.filter(e => !!e.label)) {
      texts.push(edge.label!)
    }
    content = texts.join('\r\n')
  }

  // a) ** Image or PDF ** with Text Extractor
  else if (extractor) {
    if (extractor.canFileBeExtracted(path)) {
      content = await extractor.extractText(file)
    } else {
      throw new Error('Invalid file format: ' + file.path)
    }
  }
  // b) ** Image or PDF ** without the text-extractor plugin
  else {
    if (isFilePDF(path)) {
      content = await getPdfText(file)
    } else if (isFileImage(file.path)) {
      content = await getImageText(file)
    } else {
      throw new Error('Invalid file format: ' + file.path)
    }
  }
  if (content === null || content === undefined) {
    // This shouldn't happen
    console.warn(`Omnisearch: ${content} content for file`, file.path)
    content = ''
  }
  content = removeDiacritics(content)
  const metadata = app.metadataCache.getFileCache(file)

  // Look for links that lead to non-existing files,
  // and add them to the index.
  if (metadata) {
    // // FIXME: https://github.com/scambier/obsidian-omnisearch/issues/129
    // const nonExisting = getNonExistingNotes(file, metadata)
    // for (const name of nonExisting.filter(
    //   o => !cacheManager.getLiveDocument(o)
    // )) {
    //   NotesIndex.addNonExistingToIndex(name, file.path)
    // }

    // EXCALIDRAW
    // Remove the json code
    if (metadata.frontmatter?.['excalidraw-plugin']) {
      const comments =
        metadata.sections?.filter(s => s.type === 'comment') ?? []
      for (const { start, end } of comments.map(c => c.position)) {
        content =
          content.substring(0, start.offset - 1) + content.substring(end.offset)
      }
    }
  }

  return {
    basename: removeDiacritics(file.basename),
    content,
    path: file.path,
    mtime: file.stat.mtime,

    tags: getTagsFromMetadata(metadata),
    aliases: getAliasesFromMetadata(metadata).join(''),
    headings1: metadata ? extractHeadingsFromCache(metadata, 1).join(' ') : '',
    headings2: metadata ? extractHeadingsFromCache(metadata, 2).join(' ') : '',
    headings3: metadata ? extractHeadingsFromCache(metadata, 3).join(' ') : '',
  }
}

class CacheManager {
  /**
   * Show an empty input field next time the user opens Omnisearch modal
   */
  private nextQueryIsEmpty = false

  /**
   * The "live cache", containing all indexed vault files
   * in the form of IndexedDocuments
   */
  private documents: Map<string, IndexedDocument> = new Map()

  public async addToLiveCache(path: string): Promise<void> {
    try {
      const doc = await getAndMapIndexedDocument(path)
      this.documents.set(path, doc)
    } catch (e) {
      console.warn('Omnisearch: Error while adding to live cache', e)
    }
  }

  public removeFromLiveCache(path: string): void {
    this.documents.delete(path)
  }

  public async getDocument(path: string): Promise<IndexedDocument> {
    if (this.documents.has(path)) {
      return this.documents.get(path)!
    }
    await this.addToLiveCache(path)
    return this.documents.get(path)!
  }

  public async addToSearchHistory(query: string): Promise<void> {
    if (!query) {
      this.nextQueryIsEmpty = true
      return
    }
    this.nextQueryIsEmpty = false
    let history = await database.searchHistory.toArray()
    history = history.filter(s => s.query !== query).reverse()
    history.unshift({ query })
    history = history.slice(0, 10)
    await database.searchHistory.clear()
    await database.searchHistory.bulkAdd(history)
  }

  public async getSearchHistory(): Promise<ReadonlyArray<string>> {
    const data = (await database.searchHistory.toArray())
      .reverse()
      .map(o => o.query)
    if (this.nextQueryIsEmpty) {
      data.unshift('')
    }
    return data
  }

  //#region Minisearch

  public getDocumentsChecksum(documents: IndexedDocument[]): string {
    return makeMD5(
      JSON.stringify(
        documents.sort((a, b) => {
          if (a.path < b.path) {
            return -1
          } else if (a.path > b.path) {
            return 1
          }
          return 0
        })
      )
    )
  }

  public async getMinisearchCache(): Promise<{
    paths: DocumentRef[]
    data: AsPlainObject
  } | null> {
    try {
      const cachedIndex = (await database.minisearch.toArray())[0]
      return cachedIndex
    } catch (e) {
      new Notice(
        'Omnisearch - Cache missing or invalid. Some freezes may occur while Omnisearch indexes your vault.'
      )
      console.error('Omnisearch - Error while loading Minisearch cache')
      console.error(e)
      return null
    }
  }

  public async writeMinisearchCache(
    minisearch: MiniSearch,
    indexed: Map<string, number>
  ): Promise<void> {
    const paths = Array.from(indexed).map(([k, v]) => ({ path: k, mtime: v }))
    await database.minisearch.clear()
    await database.minisearch.add({
      date: new Date().toISOString(),
      paths,
      data: minisearch.toJSON(),
    })
    console.log('Omnisearch - Search cache written')
  }

  //#endregion Minisearch
}

export const cacheManager = new CacheManager()
