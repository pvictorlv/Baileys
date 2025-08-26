/**
 * WhatsApp Meow-inspired simple decryption replacement
 * This completely replaces the complex retry system with WhatsApp Meow's approach
 */

import type { ILogger } from './logger'
import type { WAMessageKey } from '../Types'
import type { BinaryNode } from '../WABinary'
import { decryptWithPreKeyHandling, isPreKeyError } from './whatsmeow-prekey-handler'

/**
 * Simple decryption error analysis (WhatsApp Meow pattern)
 */
export function analyzeSimpleDecryptionError(error: any): { shouldIncludeKeys: boolean; type: string } {
    const errorMessage = error?.message || error?.toString() || ''
    
    if (errorMessage.includes('PreKey') || errorMessage.includes('prekey')) {
        return { shouldIncludeKeys: true, type: 'PREKEY' }
    }
    
    if (errorMessage.includes('Identity') || errorMessage.includes('identity')) {
        return { shouldIncludeKeys: true, type: 'IDENTITY' }
    }
    
    if (errorMessage.includes('Bad MAC') || errorMessage.includes('MAC')) {
        return { shouldIncludeKeys: false, type: 'MAC' }
    }
    
    if (errorMessage.includes('session') || errorMessage.includes('Session')) {
        return { shouldIncludeKeys: true, type: 'SESSION' }
    }
    
    return { shouldIncludeKeys: false, type: 'UNKNOWN' }
}

/**
 * Check if error is recoverable (WhatsApp Meow pattern)
 */
export function isSimpleRecoverableError(error: any): boolean {
    const errorMessage = error?.message || error?.toString() || ''
    
    return errorMessage.includes('PreKey') ||
           errorMessage.includes('Identity') ||
           errorMessage.includes('Bad MAC') ||
           errorMessage.includes('session') ||
           errorMessage.includes('No sender key')
}

/**
 * WhatsApp Meow pattern: Simple decryption with immediate retry request
 */
export async function simpleDecryptWithRetry(
    decryptFn: () => Promise<Uint8Array>,
    logger: ILogger,
    messageKey: WAMessageKey,
    messageType: string,
    node?: BinaryNode,
    sendRetryRequestFn?: (node: BinaryNode, forceIncludeKeys: boolean) => Promise<void>,
    fetchPreKeysFn?: (jid: string) => Promise<boolean>,
    recreateSessionFn?: (jid: string) => Promise<boolean>
): Promise<Uint8Array> {
    const senderJid = messageKey.participant || messageKey.remoteJid || ''
    
    // WhatsApp Meow pattern: Enhanced decryption with PreKey handling for pkmsg
    if (fetchPreKeysFn && recreateSessionFn && messageType === 'pkmsg') {
        logger.debug({
            messageKey,
            messageType,
            senderJid,
            hasFetchPreKeysFn: !!fetchPreKeysFn,
            hasRecreateSessionFn: !!recreateSessionFn
        }, 'Using PreKey handling for pkmsg message')
        
        try {
            return await decryptWithPreKeyHandling(
                decryptFn,
                senderJid,
                messageKey,
                logger,
                fetchPreKeysFn,
                recreateSessionFn,
                sendRetryRequestFn,
                node
            )
        } catch (error) {
            // If PreKey handling fails, continue with simple pattern
            logger.warn({
                messageKey,
                error: error.message
            }, 'PreKey handling failed, falling back to simple pattern')
        }
    }
    
    // WhatsApp Meow pattern: Simple fallback - try once, send retry, fail
    try {
        return await decryptFn()
    } catch (error) {
        logger.warn({
            messageKey,
            messageType,
            error: error.message,
            isPreKeyError: isPreKeyError(error)
        }, 'Message decryption failed')

        // WhatsApp Meow pattern: Send retry request immediately and fail
        if (sendRetryRequestFn && node && isSimpleRecoverableError(error)) {
            try {
                const errorAnalysis = analyzeSimpleDecryptionError(error)
                
                // Force include keys for PreKey errors
                const forceIncludeKeys = errorAnalysis.shouldIncludeKeys || isPreKeyError(error)
                
                logger.debug({
                    messageKey,
                    errorType: errorAnalysis.type,
                    forceIncludeKeys,
                    isPreKeyError: isPreKeyError(error)
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