/**
 * WhatsApp Meow-inspired PreKey error handling
 * This handles "Invalid PreKey ID" errors by fetching new PreKeys and recreating sessions
 */

import type { ILogger } from './logger'
import type { WAMessageKey } from '../Types'
import type { BinaryNode } from '../WABinary'

// WhatsApp Meow pattern: Track session recreation attempts
const sessionRecreationHistory = new Map<string, number>()
const RECREATION_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds

/**
 * Check if we should recreate session based on WhatsApp Meow logic
 */
function shouldRecreateSession(senderJid: string, retryCount: number): { recreate: boolean; reason: string } {
    const now = Date.now()
    const lastRecreation = sessionRecreationHistory.get(senderJid) || 0
    
    // For PreKey errors, be more aggressive - recreate on first retry (retryCount >= 1)
    if (retryCount < 1) {
        return { recreate: false, reason: 'first attempt, no retry yet' }
    }
    
    if (now - lastRecreation > RECREATION_TIMEOUT) {
        sessionRecreationHistory.set(senderJid, now)
        return { 
            recreate: true, 
            reason: `retry count ${retryCount} and over an hour since last recreation` 
        }
    }
    
    return { recreate: false, reason: `recently recreated session ${Math.round((now - lastRecreation) / 1000 / 60)} minutes ago` }
}

/**
 * Check if error is a PreKey error that requires session recreation
 */
export function isPreKeyError(error: any): boolean {
    if (!error || typeof error.message !== 'string') {
        return false
    }
    
    const message = error.message.toLowerCase()
    
    // Specific patterns for PreKey errors
    const preKeyPatterns = [
        'prekeyerror: invalid prekey id',
        'prekey not found',
        'invalid prekey',
        'prekey id not found',
        'bad prekey',
        'unknown prekey'
    ]
    
    return preKeyPatterns.some(pattern => message.includes(pattern))
}

/**
 * WhatsApp Meow pattern: Handle PreKey errors by fetching new PreKeys
 */
export async function handlePreKeyError(
    error: any,
    senderJid: string,
    messageKey: WAMessageKey,
    logger: ILogger,
    retryCount: number,
    fetchPreKeysFn?: (jid: string) => Promise<boolean>,
    recreateSessionFn?: (jid: string) => Promise<boolean>
): Promise<{ shouldRetry: boolean; reason: string }> {
    
    if (!isPreKeyError(error)) {
        return { shouldRetry: false, reason: 'not a PreKey error' }
    }
    
    logger.warn({
        error: error.message,
        senderJid,
        messageKey,
        retryCount
    }, 'PreKey error detected, checking if session recreation is needed')
    
    const { recreate, reason } = shouldRecreateSession(senderJid, retryCount)
    
    if (!recreate) {
        logger.debug({
            senderJid,
            retryCount,
            reason
        }, 'Session recreation not needed for PreKey error')
        return { shouldRetry: false, reason }
    }
    
    logger.info({
        senderJid,
        retryCount,
        reason
    }, 'Attempting to fetch new PreKeys and recreate session')
    
    try {
        // WhatsApp Meow pattern: Fetch new PreKeys first
        if (fetchPreKeysFn) {
            const fetchSuccess = await fetchPreKeysFn(senderJid)
            if (!fetchSuccess) {
                logger.warn({
                    senderJid
                }, 'Failed to fetch new PreKeys')
                return { shouldRetry: false, reason: 'failed to fetch PreKeys' }
            }
            
            logger.debug({
                senderJid
            }, 'Successfully fetched new PreKeys')
        }
        
        // WhatsApp Meow pattern: Recreate session with new PreKeys
        if (recreateSessionFn) {
            const recreateSuccess = await recreateSessionFn(senderJid)
            if (!recreateSuccess) {
                logger.warn({
                    senderJid
                }, 'Failed to recreate session with new PreKeys')
                return { shouldRetry: false, reason: 'failed to recreate session' }
            }
            
            logger.info({
                senderJid
            }, 'Successfully recreated session with new PreKeys')
        }
        
        return { 
            shouldRetry: true, 
            reason: 'session recreated with new PreKeys' 
        }
        
    } catch (recreationError) {
        logger.error({
            senderJid,
            error: recreationError.message
        }, 'Error during PreKey session recreation')
        
        return { 
            shouldRetry: false, 
            reason: `recreation failed: ${recreationError.message}` 
        }
    }
}

/**
 * WhatsApp Meow pattern: Enhanced decryption with PreKey error handling
 */
export async function decryptWithPreKeyHandling(
    decryptFn: () => Promise<Uint8Array>,
    senderJid: string,
    messageKey: WAMessageKey,
    logger: ILogger,
    fetchPreKeysFn?: (jid: string) => Promise<boolean>,
    recreateSessionFn?: (jid: string) => Promise<boolean>,
    sendRetryRequestFn?: (node: BinaryNode, forceIncludeKeys: boolean) => Promise<void>,
    node?: BinaryNode
): Promise<Uint8Array> {
    
    let retryCount = 0
    const maxRetries = 2 // WhatsApp Meow pattern: Limited retries for PreKey errors
    
    while (retryCount <= maxRetries) {
        try {
            // Try decryption
            return await decryptFn()
            
        } catch (error) {
            retryCount++
            
            logger.warn({
                error: error.message,
                senderJid,
                messageKey,
                retryCount,
                maxRetries,
                isPreKeyError: isPreKeyError(error)
            }, 'Decryption failed, analyzing error type')
            
            // Check if it's a PreKey error
            if (isPreKeyError(error)) {
                logger.warn({
                    error: error.message,
                    senderJid,
                    messageKey,
                    retryCount
                }, 'PreKey error detected during decryption')
                
                // Handle PreKey error with WhatsApp Meow pattern
                const { shouldRetry, reason } = await handlePreKeyError(
                    error,
                    senderJid,
                    messageKey,
                    logger,
                    retryCount,
                    fetchPreKeysFn,
                    recreateSessionFn
                )
                
                if (shouldRetry && retryCount <= maxRetries) {
                    logger.info({
                        senderJid,
                        messageKey,
                        retryCount,
                        reason
                    }, 'Retrying decryption after PreKey session recreation')
                    continue // Retry decryption
                } else {
                    logger.warn({
                        senderJid,
                        messageKey,
                        retryCount,
                        reason
                    }, 'Cannot retry PreKey decryption')
                }
            }
            
            // Send retry request for any decryption failure
            if (sendRetryRequestFn && node) {
                try {
                    await sendRetryRequestFn(node, retryCount > 1)
                    logger.debug({
                        senderJid,
                        messageKey,
                        retryCount
                    }, 'Sent retry request for failed decryption')
                } catch (retryError) {
                    logger.warn({
                        senderJid,
                        error: retryError.message
                    }, 'Failed to send retry request')
                }
            }
            
            // If we've exhausted retries or it's not a PreKey error, throw
            if (retryCount > maxRetries || !isPreKeyError(error)) {
                throw error
            }
        }
    }
    
    throw new Error(`Maximum PreKey retry attempts (${maxRetries}) exceeded`)
}

/**
 * Clean up old session recreation history
 */
export function cleanupSessionRecreationHistory(): void {
    const now = Date.now()
    const cutoff = now - (RECREATION_TIMEOUT * 2) // Clean up entries older than 2 hours
    
    for (const [jid, timestamp] of sessionRecreationHistory.entries()) {
        if (timestamp < cutoff) {
            sessionRecreationHistory.delete(jid)
        }
    }
}