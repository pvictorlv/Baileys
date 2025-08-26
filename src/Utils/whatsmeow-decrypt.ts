/**
 * WhatsApp Meow-inspired simple decryption logic
 * This replaces the complex retry system with WhatsApp Meow's simple approach
 */

import type { ILogger } from './logger'
import type { WAMessageKey } from '../Types'
import type { BinaryNode } from '../WABinary'
import { isRecoverableDecryptionError, analyzeDecryptionError } from './decode-wa-message'

/**
 * WhatsApp Meow pattern: Simple decryption with immediate retry request on failure
 */
export async function decryptWithWhatsmeowPattern(
    decryptFn: () => Promise<Uint8Array>,
    logger: ILogger,
    messageKey: WAMessageKey,
    messageType: string,
    node?: BinaryNode,
    sendRetryRequestFn?: (node: BinaryNode, forceIncludeKeys: boolean) => Promise<void>
): Promise<Uint8Array> {
    try {
        // WhatsApp Meow: Try decryption directly first
        return await decryptFn()
    } catch (error) {
        logger.warn({
            messageKey,
            messageType,
            error: error.message
        }, 'Message decryption failed')

        // WhatsApp Meow pattern: Send retry request immediately and fail
        if (sendRetryRequestFn && node && isRecoverableDecryptionError(error)) {
            try {
                const errorAnalysis = analyzeDecryptionError(error)
                const forceIncludeKeys = errorAnalysis.shouldIncludeKeys
                
                logger.debug({
                    messageKey,
                    errorType: errorAnalysis.type,
                    forceIncludeKeys
                }, 'Sending retry request for failed decryption')
                
                await sendRetryRequestFn(node, forceIncludeKeys)
            } catch (retryError) {
                logger.warn({
                    messageKey,
                    retryError: retryError.message
                }, 'Failed to send retry request')
            }
        }

        // WhatsApp Meow pattern: Re-throw the original error immediately
        throw error
    }
}

/**
 * WhatsApp Meow pattern: Check if error is related to group sender key
 */
export function isGroupSenderKeyError(error: any): boolean {
    const errorMessage = error?.message || error?.toString() || ''
    return errorMessage.includes('No sender key for user') || 
           errorMessage.includes('sender key') ||
           errorMessage.includes('group message')
}

/**
 * WhatsApp Meow pattern: Check if message is unavailable (should request from phone)
 */
export function shouldRequestFromPhone(messageType: string, error: any, containsDirectMsg: boolean): boolean {
    // WhatsApp Meow logic: skmsg without direct message and sender key error
    return messageType === 'skmsg' && !containsDirectMsg && isGroupSenderKeyError(error)
}