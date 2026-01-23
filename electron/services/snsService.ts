import { wcdbService } from './wcdbService'
import { ConfigService } from './config'
import { ContactCacheService } from './contactCacheService'

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

    private normalizeMediaUrl(url?: string): string {
        if (!url) return ''
        if (url.startsWith('//')) return `https:${url}`
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
            const enrichedTimeline = result.timeline.map((post: any) => {
                const contact = this.contactCache.get(post.username)

                const fixedMedia = (post.media || []).map((m: any) => ({
                    url: this.normalizeMediaUrl(m.url),
                    thumb: this.normalizeMediaUrl(m.thumb)
                }))

                return {
                    ...post,
                    avatarUrl: contact?.avatarUrl,
                    nickname: post.nickname || contact?.displayName || post.username,
                    media: fixedMedia
                }
            })

            console.log('[SnsService] Returning enriched timeline with', enrichedTimeline.length, 'posts')
            return { ...result, timeline: enrichedTimeline }
        }

        console.log('[SnsService] Returning result:', result)
        return result
    }
}

export const snsService = new SnsService()
