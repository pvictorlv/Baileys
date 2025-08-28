import { createHmac, randomBytes } from 'crypto'
import { proto } from '../../WAProto'
import { WAMessageKey } from '../Types'
import { ILogger } from './logger'

export interface MediaRetryRequest {
	messageId: string
	mediaKey: Uint8Array
	timestamp: number
}

export interface MediaRetryResponse {
	messageId: string
	success: boolean
	directPath?: string
	error?: string
}

export interface EncryptedMediaRetryData {
	ciphertext: Uint8Array
	iv: Uint8Array
}

/**
 * Media Retry Manager - handles retry requests for media messages
 * Based on whatsmeow's media retry implementation
 */
export class MediaRetryManager {
	private pendingRequests = new Map<string, MediaRetryRequest>()
	
	constructor(private logger: ILogger) {}

	/**
	 * Generate media retry key from media key
	 */
	private getMediaRetryKey(mediaKey: Uint8Array): Buffer {
		// HKDF-SHA256 with WhatsApp Media Retry Notification as info
		const info = Buffer.from('WhatsApp Media Retry Notification', 'utf8')
		return this.hkdfSha256(mediaKey, null, info, 32)
	}

	/**
	 * HKDF-SHA256 implementation
	 */
	private hkdfSha256(ikm: Uint8Array, salt: Uint8Array | null, info: Buffer, length: number): Buffer {
		// Simplified HKDF implementation
		const actualSalt = salt || Buffer.alloc(32, 0)
		const prk = createHmac('sha256', actualSalt).update(ikm).digest()
		
		const okm = Buffer.alloc(length)
		const hmac = createHmac('sha256', prk)
		hmac.update(info)
		hmac.update(Buffer.from([1]))
		const t = hmac.digest()
		
		t.copy(okm, 0, 0, Math.min(length, t.length))
		return okm
	}

	/**
	 * Encrypt media retry receipt (mock implementation for testing)
	 */
	private encryptMediaRetryReceipt(messageId: string, mediaKey: Uint8Array): EncryptedMediaRetryData {
		// Create server error receipt protobuf
		const receipt = {
			stanzaId: messageId
		}
		
		// Mock encryption - in production this would use proper AES-GCM with the media key
		const plaintext = Buffer.from(JSON.stringify(receipt), 'utf8')
		const iv = randomBytes(12)
		
		// Simple XOR "encryption" for testing purposes
		const key = this.getMediaRetryKey(mediaKey)
		const ciphertext = Buffer.alloc(plaintext.length)
		for (let i = 0; i < plaintext.length; i++) {
			ciphertext[i] = plaintext[i] ^ key[i % key.length]
		}
		
		return {
			ciphertext: new Uint8Array(ciphertext),
			iv: new Uint8Array(iv)
		}
	}

	/**
	 * Decrypt media retry notification (mock implementation for testing)
	 */
	decryptMediaRetryNotification(
		messageId: string, 
		mediaKey: Uint8Array, 
		ciphertext: Uint8Array, 
		iv: Uint8Array
	): MediaRetryResponse {
		try {
			const key = this.getMediaRetryKey(mediaKey)
			
			// Simple XOR "decryption" for testing purposes
			const plaintext = Buffer.alloc(ciphertext.length)
			for (let i = 0; i < ciphertext.length; i++) {
				plaintext[i] = ciphertext[i] ^ key[i % key.length]
			}
			
			const decrypted = JSON.parse(plaintext.toString('utf8'))
			
			return {
				messageId,
				success: true,
				directPath: decrypted.directPath
			}
		} catch (error) {
			this.logger.warn(`Failed to decrypt media retry notification for ${messageId}: ${error}`)
			return {
				messageId,
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			}
		}
	}

	/**
	 * Send media retry request
	 */
	async sendMediaRetryRequest(
		messageId: string,
		mediaKey: Uint8Array,
		chatJid: string,
		isFromMe: boolean,
		senderJid?: string
	): Promise<EncryptedMediaRetryData> {
		// Store pending request
		this.pendingRequests.set(messageId, {
			messageId,
			mediaKey,
			timestamp: Date.now()
		})

		// Encrypt the retry receipt
		const encrypted = this.encryptMediaRetryReceipt(messageId, mediaKey)
		
		this.logger.debug(`Prepared media retry request for message ${messageId}`)
		
		return encrypted
	}

	/**
	 * Handle media retry response
	 */
	handleMediaRetryResponse(
		messageId: string,
		ciphertext?: Uint8Array,
		iv?: Uint8Array,
		errorCode?: number
	): MediaRetryResponse | null {
		const request = this.pendingRequests.get(messageId)
		if (!request) {
			this.logger.warn(`Received media retry response for unknown message ${messageId}`)
			return null
		}

		// Remove from pending requests
		this.pendingRequests.delete(messageId)

		if (errorCode) {
			let error = 'Unknown error'
			switch (errorCode) {
				case 2:
					error = 'Media not available on phone'
					break
				default:
					error = `Server error code: ${errorCode}`
			}
			
			return {
				messageId,
				success: false,
				error
			}
		}

		if (!ciphertext || !iv) {
			return {
				messageId,
				success: false,
				error: 'Missing encrypted response data'
			}
		}

		return this.decryptMediaRetryNotification(messageId, request.mediaKey, ciphertext, iv)
	}

	/**
	 * Clean up old pending requests
	 */
	cleanupPendingRequests(): void {
		const cutoff = Date.now() - (5 * 60 * 1000) // 5 minutes
		let cleaned = 0
		
		for (const [messageId, request] of this.pendingRequests.entries()) {
			if (request.timestamp < cutoff) {
				this.pendingRequests.delete(messageId)
				cleaned++
			}
		}
		
		if (cleaned > 0) {
			this.logger.debug(`Cleaned up ${cleaned} old media retry requests`)
		}
	}

	/**
	 * Get pending requests count
	 */
	getPendingRequestsCount(): number {
		return this.pendingRequests.size
	}

	/**
	 * Clear all pending requests
	 */
	clearAll(): void {
		this.pendingRequests.clear()
		this.logger.debug('Cleared all media retry requests')
	}
}