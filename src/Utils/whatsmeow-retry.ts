/**
 * WhatsApp Meow-inspired simple retry request logic
 * This replaces the complex retry system with WhatsApp Meow's approach
 */

import type { ILogger } from './logger'
import type { WAMessageKey } from '../Types'
import type { BinaryNode } from '../WABinary'
import { decodeMessageNode } from './decode-wa-message'

// WhatsApp Meow pattern: Simple retry counter per message
const retryCounters = new Map<string, number>()

/**
 * WhatsApp Meow pattern: Simple retry request without complex logic
 */
export async function sendSimpleRetryRequest(
    node: BinaryNode,
    forceIncludeKeys: boolean,
    logger: ILogger,
    authState: any,
    query: any,
    requestPlaceholderResend?: (key: WAMessageKey) => Promise<string>
): Promise<void> {
    try {
        const { fullMessage } = decodeMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '')
        const { key: msgKey } = fullMessage
        const msgId = msgKey.id!
        const senderJid = node.attrs.from || ''
        
        // WhatsApp Meow pattern: Simple retry counter
        const retryKey = `${senderJid}_${msgId}_${msgKey.participant || ''}`
        const retryCount = (retryCounters.get(retryKey) || 0) + 1
        
        // WhatsApp Meow: Maximum 5 retries
        if (retryCount > 5) {
            logger.warn({
                retryCount,
                msgId,
                senderJid
            }, 'Maximum retry attempts reached (5), not sending more retry requests')
            retryCounters.delete(retryKey)
            return
        }
        
        retryCounters.set(retryKey, retryCount)
        
        logger.debug({
            retryCount,
            msgId,
            senderJid,
            forceIncludeKeys
        }, 'Sending simple retry request')
        
        // WhatsApp Meow pattern: First retry requests from phone
        if (retryCount === 1 && requestPlaceholderResend) {
            try {
                await requestPlaceholderResend(msgKey)
                logger.debug({
                    msgId,
                    senderJid
                }, 'Requested message resend from phone (first retry)')
            } catch (error) {
                logger.warn({
                    msgId,
                    error: error.message
                }, 'Failed to request resend from phone')
            }
        }
        
        // WhatsApp Meow pattern: Send retry receipt
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
        
        const receipt: BinaryNode = {
            tag: 'receipt',
            attrs: {
                id: msgId,
                to: senderJid,
                type: 'retry'
            },
            content: [
                {
                    tag: 'retry',
                    attrs: {
                        count: retryCount.toString(),
                        id: msgId,
                        t: node.attrs.t,
                        v: '1'
                    },
                    content: undefined
                }
            ]
        }
        
        // WhatsApp Meow pattern: Include keys only when necessary
        if (forceIncludeKeys || retryCount > 1) {
            try {
                const preKeys = await query({
                    tag: 'iq',
                    attrs: {
                        to: senderJid,
                        type: 'get',
                        xmlns: 'encrypt'
                    },
                    content: [
                        { tag: 'key', attrs: {}, content: undefined }
                    ]
                })
                
                if (preKeys && preKeys.content && Array.isArray(preKeys.content) && Array.isArray(receipt.content)) {
                    receipt.content.push(...preKeys.content)
                }
            } catch (keyError) {
                logger.warn({
                    msgId,
                    error: keyError.message
                }, 'Failed to fetch keys for retry request')
            }
        }
        
        await query(receipt)
        
        logger.debug({
            retryCount,
            msgId,
            senderJid,
            includeKeys: forceIncludeKeys || retryCount > 1
        }, 'Sent simple retry request successfully')
        
    } catch (error) {
        logger.error({
            error: error.message,
            nodeAttrs: node.attrs
        }, 'Failed to send simple retry request')
    }
}

/**
 * Clean up old retry counters (WhatsApp Meow pattern)
 */
export function cleanupRetryCounters(): void {
    // WhatsApp Meow pattern: Simple cleanup - clear all after some time
    if (retryCounters.size > 1000) {
        retryCounters.clear()
    }
}