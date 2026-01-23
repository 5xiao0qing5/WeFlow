import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { ContactCacheService } from './contactCacheService'
import { imageDecryptService } from './imageDecryptService'
import path from 'path'

export interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: { url: string; thumb: string }[]
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[]
}

class SnsService {
    private contactCache: ContactCacheService

    constructor() {
        const config = new ConfigService()
        this.contactCache = new ContactCacheService(config.get('cachePath') as string)
    }

    private normalizeMediaUrl(url: string): string {
        if (!url) return url
        return url.startsWith('http://') ? url.replace('http://', 'https://') : url
    }

    private isRemoteMedia(url: string): boolean {
        return /^https?:\/\//i.test(url) || url.startsWith('data:')
    }

    private extractMediaKey(url: string): string | undefined {
        if (!url) return undefined
        const cleanUrl = url.replace(/^file:\/\//i, '').split('?')[0]
        const baseName = path.basename(cleanUrl)
        const withoutExt = baseName.replace(/\.(dat|jpg|jpeg|png|gif|webp)$/i, '')
        const trimmed = withoutExt.replace(/_(thumb|hd)$/i, '')
        const md5Match = /([a-f0-9]{16,32})/i.exec(trimmed) || /([a-f0-9]{16,32})/i.exec(cleanUrl)
        return md5Match?.[1] || (trimmed ? trimmed : undefined)
    }

    private async resolveMediaPath(url: string, sessionId?: string): Promise<string> {
        if (!url || this.isRemoteMedia(url)) return url
        const key = this.extractMediaKey(url)
        if (!key) return url
        const cached = await imageDecryptService.resolveCachedImage({ sessionId, imageDatName: key })
        if (cached.success && cached.localPath) {
            return cached.localPath
        }
        const decrypted = await imageDecryptService.decryptImage({ sessionId, imageDatName: key })
        if (decrypted.success && decrypted.localPath) {
            return decrypted.localPath
        }
        return url
    }

    async getTimeline(limit: number = 20, offset: number = 0, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
        console.log('[SnsService] getTimeline called with:', { limit, offset, usernames, keyword, startTime, endTime })

        const result = await wcdbService.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)

        console.log('[SnsService] getSnsTimeline result:', {
            success: result.success,
            timelineCount: result.timeline?.length,
            error: result.error
        })

        if (result.success && result.timeline) {
            const enrichedTimeline = await Promise.all(result.timeline.map(async (post: any) => {
                const contact = this.contactCache.get(post.username)

                const fixedMedia = await Promise.all(post.media.map(async (m: any) => {
                    const url = this.normalizeMediaUrl(m.url)
                    const thumb = this.normalizeMediaUrl(m.thumb)
                    const [resolvedUrl, resolvedThumb] = await Promise.all([
                        this.resolveMediaPath(url, post.username),
                        this.resolveMediaPath(thumb, post.username)
                    ])
                    return {
                        ...m,
                        url: resolvedUrl,
                        thumb: resolvedThumb
                    }
                }))

                return {
                    ...post,
                    avatarUrl: contact?.avatarUrl,
                    nickname: post.nickname || contact?.displayName || post.username,
                    media: fixedMedia
                }
            }))

            console.log('[SnsService] Returning enriched timeline with', enrichedTimeline.length, 'posts')
            return { ...result, timeline: enrichedTimeline }
        }

        console.log('[SnsService] Returning result:', result)
        return result
    }
}

export const snsService = new SnsService()
