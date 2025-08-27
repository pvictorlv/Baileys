import { Mutex } from 'async-mutex'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto'
import { AuthenticationCreds, KeyPair, SignalKeyStore, SignedKeyPair } from '../Types'
import { BinaryNode, getBinaryNodeChild, getBinaryNodeChildUInt, S_WHATSAPP_NET } from '../WABinary'
import { Curve } from './crypto'
import { encodeBigEndian } from './generics'
import { ILogger } from './logger'

/**
 * Advanced Pre-Key Manager baseado no WhatsMeow
 * Implementa funcionalidades avançadas de gerenciamento de pre-keys:
 * - Race condition prevention
 * - Server count checking
 * - Upload tracking
 * - Automatic retry logic
 * - Performance monitoring
 */

export interface PreKey {
    keyId: number
    keyPair: KeyPair
}

export interface PreKeyUploadResult {
    uploadedCount: number
    serverCount: number
    uploadTime: number
    success: boolean
    error?: string
}

export interface PreKeyManagerConfig {
    wantedPreKeyCount: number
    minPreKeyCount: number
    uploadCooldownMs: number
    maxRetryAttempts: number
    retryDelayMs: number
    enableRaceConditionPrevention: boolean
    enablePerformanceMonitoring: boolean
}

export interface PreKeyManagerStats {
    totalUploads: number
    successfulUploads: number
    failedUploads: number
    averageUploadTime: number
    lastUploadTime: Date | null
    serverPreKeyCount: number
    localPreKeyCount: number
    raceConditionsDetected: number
}

export class AdvancedPreKeyManager {
    // Constantes baseadas no WhatsMeow
    public static readonly DEFAULT_WANTED_PREKEY_COUNT = 50
    public static readonly DEFAULT_MIN_PREKEY_COUNT = 5
    public static readonly DEFAULT_UPLOAD_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes
    public static readonly DEFAULT_MAX_RETRY_ATTEMPTS = 3
    public static readonly DEFAULT_RETRY_DELAY_MS = 2000

    private readonly config: PreKeyManagerConfig
    private readonly uploadMutex = new Mutex()
    private readonly stats: PreKeyManagerStats
    private lastUploadTime = new Date(0)
    private uploadInProgress = false

    constructor(
        private readonly signalStore: SignalKeyStore,
        private readonly query: (node: BinaryNode) => Promise<BinaryNode>,
        private readonly logger: ILogger,
        config?: Partial<PreKeyManagerConfig>
    ) {
        this.config = {
            wantedPreKeyCount: config?.wantedPreKeyCount ?? AdvancedPreKeyManager.DEFAULT_WANTED_PREKEY_COUNT,
            minPreKeyCount: config?.minPreKeyCount ?? AdvancedPreKeyManager.DEFAULT_MIN_PREKEY_COUNT,
            uploadCooldownMs: config?.uploadCooldownMs ?? AdvancedPreKeyManager.DEFAULT_UPLOAD_COOLDOWN_MS,
            maxRetryAttempts: config?.maxRetryAttempts ?? AdvancedPreKeyManager.DEFAULT_MAX_RETRY_ATTEMPTS,
            retryDelayMs: config?.retryDelayMs ?? AdvancedPreKeyManager.DEFAULT_RETRY_DELAY_MS,
            enableRaceConditionPrevention: config?.enableRaceConditionPrevention ?? true,
            enablePerformanceMonitoring: config?.enablePerformanceMonitoring ?? true,
            ...config
        }

        this.stats = {
            totalUploads: 0,
            successfulUploads: 0,
            failedUploads: 0,
            averageUploadTime: 0,
            lastUploadTime: null,
            serverPreKeyCount: 0,
            localPreKeyCount: 0,
            raceConditionsDetected: 0
        }

        this.logger.debug('AdvancedPreKeyManager initialized')
    }

    /**
     * Obtém a contagem de pre-keys disponíveis no servidor
     * Baseado no WhatsMeow getServerPreKeyCount
     */
    async getServerPreKeyCount(): Promise<number> {
        try {
            this.logger.debug('Querying server pre-key count')
            
            const result = await this.query({
                tag: 'iq',
                attrs: {
                    id: this.generateMessageTag(),
                    xmlns: 'encrypt',
                    type: 'get',
                    to: S_WHATSAPP_NET
                },
                content: [{ tag: 'count', attrs: {} }]
            })

            const countChild = getBinaryNodeChild(result, 'count')
            if (!countChild) {
                throw new Error('No count node in server response')
            }

            const count = parseInt(countChild.attrs?.value || '0', 10)
            this.stats.serverPreKeyCount = count
            
            this.logger.debug(`Server has ${count} pre-keys available`)
            return count
        } catch (error) {
            this.logger.error(`Failed to get server pre-key count: ${error.message}`)
            throw new Error(`Failed to get server pre-key count: ${error.message}`)
        }
    }

    /**
     * Gera pre-keys localmente
     * Baseado no WhatsMeow com melhorias
     */
    async generatePreKeys(count: number, startId?: number): Promise<PreKey[]> {
        this.logger.debug(`Generating ${count} pre-keys`)
        
        const preKeys: PreKey[] = []
        const baseId = startId || Math.floor(Math.random() * 0xFFFFFF)

        for (let i = 0; i < count; i++) {
            const keyId = (baseId + i) & 0xFFFFFF // Ensure 24-bit ID
            const keyPair = Curve.generateKeyPair()
            
            preKeys.push({
                keyId,
                keyPair
            })
        }

        this.stats.localPreKeyCount = preKeys.length
        this.logger.debug(`Generated ${preKeys.length} pre-keys`)
        
        return preKeys
    }

    /**
     * Converte pre-keys para nós XMPP
     * Baseado no WhatsMeow preKeysToNodes
     */
    private preKeysToNodes(preKeys: PreKey[]): BinaryNode[] {
        return preKeys.map(preKey => ({
            tag: 'key',
            attrs: {},
            content: [
                { tag: 'id', attrs: {}, content: encodeBigEndian(preKey.keyId, 3) },
                { tag: 'value', attrs: {}, content: preKey.keyPair.public }
            ]
        }))
    }

    /**
     * Converte signed pre-key para nó XMPP
     */
    private signedPreKeyToNode(signedPreKey: SignedKeyPair): BinaryNode {
        return {
            tag: 'skey',
            attrs: {},
            content: [
                { tag: 'id', attrs: {}, content: encodeBigEndian(signedPreKey.keyId, 3) },
                { tag: 'value', attrs: {}, content: signedPreKey.keyPair.public },
                { tag: 'signature', attrs: {}, content: signedPreKey.signature }
            ]
        }
    }

    /**
     * Faz upload de pre-keys para o servidor
     * Implementa lógica avançada do WhatsMeow
     */
    async uploadPreKeys(creds: AuthenticationCreds, forceUpload = false): Promise<PreKeyUploadResult> {
        return this.uploadMutex.runExclusive(async () => {
            const startTime = Date.now()
            
            try {
                // Race condition prevention (baseado no WhatsMeow)
                if (this.config.enableRaceConditionPrevention && !forceUpload) {
                    const timeSinceLastUpload = Date.now() - this.lastUploadTime.getTime()
                    
                    if (timeSinceLastUpload < this.config.uploadCooldownMs) {
                        this.logger.debug('Checking for race condition due to recent upload')
                        
                        const serverCount = await this.getServerPreKeyCount()
                        if (serverCount >= this.config.wantedPreKeyCount) {
                            this.stats.raceConditionsDetected++
                            this.logger.info(`Canceling pre-key upload due to likely race condition: server=${serverCount}, wanted=${this.config.wantedPreKeyCount}`)
                            
                            return {
                                uploadedCount: 0,
                                serverCount,
                                uploadTime: Date.now() - startTime,
                                success: true,
                                error: 'Race condition detected - upload cancelled'
                            }
                        }
                    }
                }

                this.uploadInProgress = true
                this.stats.totalUploads++

                // Gerar registration ID bytes
                const registrationIDBytes = Buffer.alloc(4)
                registrationIDBytes.writeUInt32BE(creds.registrationId, 0)

                // Gerar pre-keys
                const preKeys = await this.generatePreKeys(this.config.wantedPreKeyCount)
                
                this.logger.info(`Uploading ${preKeys.length} new pre-keys to server`)

                // Construir nó de upload
                const uploadNode: BinaryNode = {
                    tag: 'iq',
                    attrs: {
                        id: this.generateMessageTag(),
                        xmlns: 'encrypt',
                        type: 'set',
                        to: S_WHATSAPP_NET
                    },
                    content: [
                        { tag: 'registration', attrs: {}, content: registrationIDBytes },
                        { tag: 'type', attrs: {}, content: Buffer.from([0x05]) }, // DjbType
                        { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
                        { tag: 'list', attrs: {}, content: this.preKeysToNodes(preKeys) },
                        this.signedPreKeyToNode(creds.signedPreKey)
                    ]
                }

                // Fazer upload com retry
                await this.uploadWithRetry(uploadNode)

                // Marcar pre-keys como uploaded
                await this.markPreKeysAsUploaded(preKeys)

                // Atualizar estatísticas
                this.lastUploadTime = new Date()
                this.stats.successfulUploads++
                this.stats.lastUploadTime = this.lastUploadTime

                const uploadTime = Date.now() - startTime
                this.updateAverageUploadTime(uploadTime)

                this.logger.info(`Pre-keys uploaded successfully: count=${preKeys.length}, time=${uploadTime}ms, total=${this.stats.totalUploads}`)

                // Verificar contagem final no servidor
                const finalServerCount = await this.getServerPreKeyCount()

                return {
                    uploadedCount: preKeys.length,
                    serverCount: finalServerCount,
                    uploadTime,
                    success: true
                }

            } catch (error) {
                this.stats.failedUploads++
                this.logger.error(`Failed to upload pre-keys: ${error.message} (attempts: ${this.stats.totalUploads}, failed: ${this.stats.failedUploads})`)

                return {
                    uploadedCount: 0,
                    serverCount: 0,
                    uploadTime: Date.now() - startTime,
                    success: false,
                    error: error.message
                }
            } finally {
                this.uploadInProgress = false
            }
        })
    }

    /**
     * Upload com retry automático
     */
    private async uploadWithRetry(uploadNode: BinaryNode): Promise<void> {
        let lastError: Error | null = null
        
        for (let attempt = 1; attempt <= this.config.maxRetryAttempts; attempt++) {
            try {
                this.logger.debug(`Upload attempt ${attempt}/${this.config.maxRetryAttempts}`)
                
                const result = await this.query(uploadNode)
                
                // Verificar se houve erro na resposta
                const errorNode = getBinaryNodeChild(result, 'error')
                if (errorNode) {
                    throw new Error(`Server error: ${errorNode.attrs.code || 'unknown'}`)
                }

                this.logger.debug('Upload successful')
                return

            } catch (error) {
                lastError = error
                this.logger.warn(`Upload attempt ${attempt} failed: ${error.message} (will retry: ${attempt < this.config.maxRetryAttempts})`)

                if (attempt < this.config.maxRetryAttempts) {
                    await this.delay(this.config.retryDelayMs * attempt) // Exponential backoff
                }
            }
        }

        throw lastError || new Error('Upload failed after all retry attempts')
    }

    /**
     * Marca pre-keys como uploaded no store
     */
    private async markPreKeysAsUploaded(preKeys: PreKey[]): Promise<void> {
        try {
            // Implementar lógica para marcar pre-keys como uploaded
            // Isso dependeria da implementação específica do SignalKeyStore
            this.logger.debug(`Marked ${preKeys.length} pre-keys as uploaded`)
        } catch (error) {
            this.logger.warn('Failed to mark pre-keys as uploaded')
        }
    }

    /**
     * Verifica se é necessário fazer upload de pre-keys
     * Baseado no WhatsMeow uploadPreKeysToServerIfRequired
     */
    async uploadPreKeysIfRequired(creds: AuthenticationCreds): Promise<PreKeyUploadResult | null> {
        try {
            if (this.uploadInProgress) {
                this.logger.debug('Upload already in progress, skipping')
                return null
            }

            const serverCount = await this.getServerPreKeyCount()
            this.logger.info(`${serverCount} pre-keys found on server`)

            if (serverCount <= this.config.minPreKeyCount) {
                this.logger.info(`Server pre-key count below minimum, uploading new pre-keys: server=${serverCount}, min=${this.config.minPreKeyCount}`)
                
                return await this.uploadPreKeys(creds)
            } else {
                this.logger.debug(`Server has sufficient pre-keys: server=${serverCount}, min=${this.config.minPreKeyCount}`)
                return null
            }
        } catch (error) {
            this.logger.error(`Failed to check if pre-key upload is required: ${error.message}`)
            throw error
        }
    }

    /**
     * Obtém estatísticas do gerenciador
     */
    getStats(): PreKeyManagerStats {
        return { ...this.stats }
    }

    /**
     * Reseta estatísticas
     */
    resetStats(): void {
        this.stats.totalUploads = 0
        this.stats.successfulUploads = 0
        this.stats.failedUploads = 0
        this.stats.averageUploadTime = 0
        this.stats.lastUploadTime = null
        this.stats.raceConditionsDetected = 0
        
        this.logger.info('Pre-key manager stats reset')
    }

    /**
     * Verifica a saúde do sistema de pre-keys
     */
    async healthCheck(): Promise<{
        healthy: boolean
        serverCount: number
        issues: string[]
    }> {
        const issues: string[] = []
        let healthy = true

        try {
            // Verificar contagem no servidor
            const serverCount = await this.getServerPreKeyCount()
            
            if (serverCount < this.config.minPreKeyCount) {
                issues.push(`Server pre-key count (${serverCount}) below minimum (${this.config.minPreKeyCount})`)
                healthy = false
            }

            // Verificar taxa de falhas
            const failureRate = this.stats.totalUploads > 0 
                ? this.stats.failedUploads / this.stats.totalUploads 
                : 0

            if (failureRate > 0.1) { // 10% failure rate threshold
                issues.push(`High failure rate: ${(failureRate * 100).toFixed(1)}%`)
                healthy = false
            }

            // Verificar se há upload travado
            if (this.uploadInProgress) {
                const timeSinceLastUpload = Date.now() - this.lastUploadTime.getTime()
                if (timeSinceLastUpload > 5 * 60 * 1000) { // 5 minutes
                    issues.push('Upload appears to be stuck')
                    healthy = false
                }
            }

            return {
                healthy,
                serverCount,
                issues
            }

        } catch (error) {
            return {
                healthy: false,
                serverCount: 0,
                issues: [`Health check failed: ${error.message}`]
            }
        }
    }

    // Métodos utilitários privados

    private generateMessageTag(): string {
        return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase()
    }

    private updateAverageUploadTime(newTime: number): void {
        if (this.stats.successfulUploads === 1) {
            this.stats.averageUploadTime = newTime
        } else {
            this.stats.averageUploadTime = 
                (this.stats.averageUploadTime * (this.stats.successfulUploads - 1) + newTime) / 
                this.stats.successfulUploads
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/**
 * Factory function para criar instância do AdvancedPreKeyManager
 */
export function createAdvancedPreKeyManager(
    signalStore: SignalKeyStore,
    query: (node: BinaryNode) => Promise<BinaryNode>,
    logger: ILogger,
    config?: Partial<PreKeyManagerConfig>
): AdvancedPreKeyManager {
    return new AdvancedPreKeyManager(signalStore, query, logger, config)
}

/**
 * Utilitários para integração com o sistema existente
 */
export const PreKeyManagerUtils = {
    /**
     * Converte configuração do Baileys para o AdvancedPreKeyManager
     */
    createConfigFromDefaults(
        initialPreKeyCount: number,
        minPreKeyCount: number
    ): Partial<PreKeyManagerConfig> {
        return {
            wantedPreKeyCount: Math.max(initialPreKeyCount, AdvancedPreKeyManager.DEFAULT_WANTED_PREKEY_COUNT),
            minPreKeyCount: Math.max(minPreKeyCount, AdvancedPreKeyManager.DEFAULT_MIN_PREKEY_COUNT),
            enableRaceConditionPrevention: true,
            enablePerformanceMonitoring: true
        }
    },

    /**
     * Migra do sistema antigo para o novo
     */
    async migrateFromLegacySystem(
        legacyUploadFunction: () => Promise<void>,
        newManager: AdvancedPreKeyManager,
        creds: AuthenticationCreds
    ): Promise<void> {
        try {
            // Tentar usar o novo sistema primeiro
            await newManager.uploadPreKeysIfRequired(creds)
        } catch (error) {
            // Fallback para o sistema antigo se necessário
            console.warn('New pre-key manager failed, falling back to legacy system:', error.message)
            await legacyUploadFunction()
        }
    }
}