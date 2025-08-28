import { proto } from '../../WAProto'
import { WAMessageKey } from '../Types'
import { ILogger } from './logger'

/** Number of sent messages to cache in memory for handling retry receipts */
const RECENT_MESSAGES_SIZE = 512

/** Timeout for session recreation - 1 hour */
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds

/** Maximum retry attempts per message */
const MAX_RETRY_ATTEMPTS = 10

/** Delay before requesting message from phone */
const PHONE_REQUEST_DELAY = 5000 // 5 seconds

export interface RecentMessageKey {
	to: string
	id: string
}

export interface RecentMessage {
	message: proto.IMessage
	timestamp: number
	mediaKey?: Uint8Array // For media retry support
}

export interface SessionRecreateHistory {
	[jid: string]: number // timestamp
}

export interface RetryCounter {
	[messageId: string]: number
}

export interface PendingPhoneRequest {
	[messageId: string]: NodeJS.Timeout
}

export interface RetryStatistics {
	totalRetries: number
	successfulRetries: number
	failedRetries: number
	mediaRetries: number
	sessionRecreations: number
	phoneRequests: number
}

export class MessageRetryManager {
	private recentMessagesMap = new Map<string, RecentMessage>()
	private recentMessagesList: RecentMessageKey[] = new Array(RECENT_MESSAGES_SIZE)
	private recentMessagesPtr = 0
	private sessionRecreateHistory: SessionRecreateHistory = {}
	private retryCounters: RetryCounter = {}
	private pendingPhoneRequests: PendingPhoneRequest = {}
	private statistics: RetryStatistics = {
		totalRetries: 0,
		successfulRetries: 0,
		failedRetries: 0,
		mediaRetries: 0,
		sessionRecreations: 0,
		phoneRequests: 0
	}
	
	constructor(private logger: ILogger) {
		// Initialize the array with empty objects
		for (let i = 0; i < RECENT_MESSAGES_SIZE; i++) {
			this.recentMessagesList[i] = { to: '', id: '' }
		}
	}

	/**
	 * Add a recent message to the cache for retry handling
	 */
	addRecentMessage(to: string, id: string, message: proto.IMessage, mediaKey?: Uint8Array): void {
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)
		
		// Remove old message if the slot is occupied
		const oldKey = this.recentMessagesList[this.recentMessagesPtr]
		if (oldKey.id !== '') {
			const oldKeyStr = this.keyToString(oldKey)
			this.recentMessagesMap.delete(oldKeyStr)
		}
		
		// Add new message
		this.recentMessagesMap.set(keyStr, {
			message,
			timestamp: Date.now(),
			mediaKey
		})
		
		this.recentMessagesList[this.recentMessagesPtr] = key
		this.recentMessagesPtr++
		
		if (this.recentMessagesPtr >= RECENT_MESSAGES_SIZE) {
			this.recentMessagesPtr = 0
		}
		
		this.logger.debug(`Added message to retry cache: ${to}/${id}${mediaKey ? ' (with media key)' : ''}`)
	}

	/**
	 * Get a recent message from the cache
	 */
	getRecentMessage(to: string, id: string): RecentMessage | undefined {
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)
		return this.recentMessagesMap.get(keyStr)
	}

	/**
	 * Check if a session should be recreated based on retry count and history
	 */
	shouldRecreateSession(jid: string, retryCount: number, hasSession: boolean): { reason: string; recreate: boolean } {
		// If we don't have a session, always recreate
		if (!hasSession) {
			this.sessionRecreateHistory[jid] = Date.now()
			this.statistics.sessionRecreations++
			return {
				reason: "we don't have a Signal session with them",
				recreate: true
			}
		}
		
		// Only consider recreation if retry count > 1
		if (retryCount < 2) {
			return { reason: '', recreate: false }
		}
		
		const now = Date.now()
		const prevTime = this.sessionRecreateHistory[jid]
		
		// If no previous recreation or it's been more than an hour
		if (!prevTime || (now - prevTime) > RECREATE_SESSION_TIMEOUT) {
			this.sessionRecreateHistory[jid] = now
			this.statistics.sessionRecreations++
			return {
				reason: 'retry count > 1 and over an hour since last recreation',
				recreate: true
			}
		}
		
		return { reason: '', recreate: false }
	}

	/**
	 * Increment retry counter for a message
	 */
	incrementRetryCount(messageId: string): number {
		this.retryCounters[messageId] = (this.retryCounters[messageId] || 0) + 1
		this.statistics.totalRetries++
		return this.retryCounters[messageId]
	}

	/**
	 * Get retry count for a message
	 */
	getRetryCount(messageId: string): number {
		return this.retryCounters[messageId] || 0
	}

	/**
	 * Check if message has exceeded maximum retry attempts
	 */
	hasExceededMaxRetries(messageId: string): boolean {
		return this.getRetryCount(messageId) >= MAX_RETRY_ATTEMPTS
	}

	/**
	 * Mark retry as successful
	 */
	markRetrySuccess(messageId: string): void {
		this.statistics.successfulRetries++
		// Clean up retry counter for successful message
		delete this.retryCounters[messageId]
		this.cancelPendingPhoneRequest(messageId)
	}

	/**
	 * Mark retry as failed
	 */
	markRetryFailed(messageId: string): void {
		this.statistics.failedRetries++
	}

	/**
	 * Mark media retry
	 */
	markMediaRetry(messageId: string): void {
		this.statistics.mediaRetries++
	}

	/**
	 * Schedule a phone request with delay
	 */
	schedulePhoneRequest(messageId: string, callback: () => void, delay: number = PHONE_REQUEST_DELAY): void {
		// Cancel any existing request for this message
		this.cancelPendingPhoneRequest(messageId)
		
		this.pendingPhoneRequests[messageId] = setTimeout(() => {
			delete this.pendingPhoneRequests[messageId]
			this.statistics.phoneRequests++
			callback()
		}, delay)
		
		this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`)
	}

	/**
	 * Cancel pending phone request
	 */
	cancelPendingPhoneRequest(messageId: string): void {
		const timeout = this.pendingPhoneRequests[messageId]
		if (timeout) {
			clearTimeout(timeout)
			delete this.pendingPhoneRequests[messageId]
			this.logger.debug(`Cancelled pending phone request for message ${messageId}`)
		}
	}

	/**
	 * Cancel all pending phone requests
	 */
	cancelAllPendingPhoneRequests(): void {
		for (const messageId in this.pendingPhoneRequests) {
			this.cancelPendingPhoneRequest(messageId)
		}
		this.logger.debug('Cancelled all pending phone requests')
	}

	/**
	 * Clear old entries from session recreate history
	 */
	cleanupSessionHistory(): void {
		const now = Date.now()
		const cutoff = now - (RECREATE_SESSION_TIMEOUT * 2) // Keep for 2 hours
		
		for (const [jid, timestamp] of Object.entries(this.sessionRecreateHistory)) {
			if (timestamp < cutoff) {
				delete this.sessionRecreateHistory[jid]
			}
		}
		
		// Also cleanup retry counters
		this.cleanupRetryCounters()
	}

	/**
	 * Get cache statistics for debugging
	 */
	getCacheStats(): { 
		recentMessages: number; 
		sessionHistory: number; 
		retryCounters: number; 
		pendingPhoneRequests: number;
	} {
		return {
			recentMessages: this.recentMessagesMap.size,
			sessionHistory: Object.keys(this.sessionRecreateHistory).length,
			retryCounters: Object.keys(this.retryCounters).length,
			pendingPhoneRequests: Object.keys(this.pendingPhoneRequests).length
		}
	}

	/**
	 * Get retry statistics
	 */
	getRetryStatistics(): RetryStatistics {
		return { ...this.statistics }
	}

	/**
	 * Reset retry statistics
	 */
	resetStatistics(): void {
		this.statistics = {
			totalRetries: 0,
			successfulRetries: 0,
			failedRetries: 0,
			mediaRetries: 0,
			sessionRecreations: 0,
			phoneRequests: 0
		}
		this.logger.debug('Reset retry statistics')
	}

	/**
	 * Clean up old retry counters
	 */
	cleanupRetryCounters(): void {
		const cutoff = Date.now() - (RECREATE_SESSION_TIMEOUT * 2) // Keep for 2 hours
		let cleaned = 0
		
		// Clean up old retry counters (this is a simple cleanup, in production you might want to track timestamps)
		for (const messageId in this.retryCounters) {
			// For now, just clean up counters that have exceeded max retries
			if (this.retryCounters[messageId] >= MAX_RETRY_ATTEMPTS) {
				delete this.retryCounters[messageId]
				cleaned++
			}
		}
		
		if (cleaned > 0) {
			this.logger.debug(`Cleaned up ${cleaned} old retry counters`)
		}
	}

	/**
	 * Clear all caches
	 */
	clearAll(): void {
		this.recentMessagesMap.clear()
		this.sessionRecreateHistory = {}
		this.retryCounters = {}
		this.cancelAllPendingPhoneRequests()
		this.recentMessagesPtr = 0
		
		// Reset the array
		for (let i = 0; i < RECENT_MESSAGES_SIZE; i++) {
			this.recentMessagesList[i] = { to: '', id: '' }
		}
		
		this.logger.debug('Cleared all retry manager caches')
	}

	private keyToString(key: RecentMessageKey): string {
		return `${key.to}:${key.id}`
	}
}