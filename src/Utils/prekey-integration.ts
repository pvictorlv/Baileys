import { INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT } from '../Defaults'
import { AuthenticationCreds, SignalKeyStore } from '../Types'
import { BinaryNode } from '../WABinary'
import { ILogger } from './logger'
import { 
    AdvancedPreKeyManager, 
    createAdvancedPreKeyManager, 
    PreKeyManagerConfig,
    PreKeyManagerUtils
} from './advanced-prekey-manager'

/**
 * Integração do AdvancedPreKeyManager com o sistema existente do Baileys
 * Substitui as funções legadas de pre-key management
 */

export interface PreKeyIntegrationConfig {
    enableAdvancedManager: boolean
    fallbackToLegacy: boolean
    config?: Partial<PreKeyManagerConfig>
}

export class PreKeyIntegration {
    private advancedManager: AdvancedPreKeyManager | null = null
    private readonly config: PreKeyIntegrationConfig

    constructor(
        private readonly signalStore: SignalKeyStore,
        private readonly query: (node: BinaryNode) => Promise<BinaryNode>,
        private readonly logger: ILogger,
        config?: Partial<PreKeyIntegrationConfig>
    ) {
        this.config = {
            enableAdvancedManager: true,
            fallbackToLegacy: true,
            ...config
        }

        if (this.config.enableAdvancedManager) {
            this.initializeAdvancedManager()
        }
    }

    private initializeAdvancedManager(): void {
        try {
            const managerConfig = PreKeyManagerUtils.createConfigFromDefaults(
                INITIAL_PREKEY_COUNT,
                MIN_PREKEY_COUNT
            )

            // Merge com configuração personalizada se fornecida
            const finalConfig = {
                ...managerConfig,
                ...this.config.config
            }

            this.advancedManager = createAdvancedPreKeyManager(
                this.signalStore,
                this.query,
                this.logger,
                finalConfig
            )

            this.logger.info('Advanced PreKey Manager initialized successfully')
        } catch (error) {
            this.logger.error('Failed to initialize Advanced PreKey Manager', { error: error.message })
            
            if (!this.config.fallbackToLegacy) {
                throw error
            }
        }
    }

    /**
     * Substitui a função uploadPreKeys original
     */
    async uploadPreKeys(creds: AuthenticationCreds, count?: number): Promise<void> {
        if (this.advancedManager && this.config.enableAdvancedManager) {
            try {
                this.logger.debug('Using Advanced PreKey Manager for upload')
                
                const result = await this.advancedManager.uploadPreKeys(creds, true)
                
                if (!result.success) {
                    throw new Error(result.error || 'Upload failed')
                }

                this.logger.info('Pre-keys uploaded successfully via Advanced Manager', {
                    uploadedCount: result.uploadedCount,
                    serverCount: result.serverCount,
                    uploadTime: result.uploadTime
                })

                return
            } catch (error) {
                this.logger.error('Advanced PreKey Manager upload failed', { error: error.message })
                
                if (!this.config.fallbackToLegacy) {
                    throw error
                }
                
                this.logger.warn('Falling back to legacy pre-key upload')
            }
        }

        // Fallback para sistema legado
        await this.legacyUploadPreKeys(creds, count || INITIAL_PREKEY_COUNT)
    }

    /**
     * Substitui a função uploadPreKeysToServerIfRequired original
     */
    async uploadPreKeysToServerIfRequired(creds: AuthenticationCreds): Promise<void> {
        if (this.advancedManager && this.config.enableAdvancedManager) {
            try {
                this.logger.debug('Using Advanced PreKey Manager for conditional upload')
                
                const result = await this.advancedManager.uploadPreKeysIfRequired(creds)
                
                if (result) {
                    this.logger.info('Pre-keys uploaded conditionally via Advanced Manager', {
                        uploadedCount: result.uploadedCount,
                        serverCount: result.serverCount,
                        uploadTime: result.uploadTime
                    })
                } else {
                    this.logger.debug('No pre-key upload required')
                }

                return
            } catch (error) {
                this.logger.error('Advanced PreKey Manager conditional upload failed', { error: error.message })
                
                if (!this.config.fallbackToLegacy) {
                    throw error
                }
                
                this.logger.warn('Falling back to legacy conditional upload')
            }
        }

        // Fallback para sistema legado
        await this.legacyUploadPreKeysToServerIfRequired(creds)
    }

    /**
     * Obtém contagem de pre-keys no servidor
     */
    async getAvailablePreKeysOnServer(): Promise<number> {
        if (this.advancedManager && this.config.enableAdvancedManager) {
            try {
                return await this.advancedManager.getServerPreKeyCount()
            } catch (error) {
                this.logger.error('Advanced PreKey Manager server count failed', { error: error.message })
                
                if (!this.config.fallbackToLegacy) {
                    throw error
                }
            }
        }

        // Fallback para sistema legado
        return await this.legacyGetAvailablePreKeysOnServer()
    }

    /**
     * Obtém estatísticas do gerenciador avançado
     */
    getAdvancedStats() {
        return this.advancedManager?.getStats() || null
    }

    /**
     * Executa health check do sistema de pre-keys
     */
    async healthCheck() {
        if (this.advancedManager && this.config.enableAdvancedManager) {
            return await this.advancedManager.healthCheck()
        }

        // Health check básico para sistema legado
        try {
            const serverCount = await this.getAvailablePreKeysOnServer()
            return {
                healthy: serverCount > MIN_PREKEY_COUNT,
                serverCount,
                issues: serverCount <= MIN_PREKEY_COUNT 
                    ? [`Server pre-key count (${serverCount}) below minimum (${MIN_PREKEY_COUNT})`]
                    : []
            }
        } catch (error) {
            return {
                healthy: false,
                serverCount: 0,
                issues: [`Health check failed: ${error.message}`]
            }
        }
    }

    /**
     * Reseta estatísticas (apenas para gerenciador avançado)
     */
    resetStats(): void {
        this.advancedManager?.resetStats()
    }

    // Implementações legadas (fallback)

    private async legacyUploadPreKeys(creds: AuthenticationCreds, count: number): Promise<void> {
        this.logger.info('Using legacy pre-key upload', { count })
        
        // Implementação simplificada baseada no código original
        const { getNextPreKeysNode } = await import('./signal')
        
        const { update, node } = await getNextPreKeysNode(
            { creds, keys: this.signalStore }, 
            count
        )

        await this.query(node)
        
        this.logger.info('Legacy pre-key upload completed', { count })
    }

    private async legacyUploadPreKeysToServerIfRequired(creds: AuthenticationCreds): Promise<void> {
        const preKeyCount = await this.legacyGetAvailablePreKeysOnServer()
        this.logger.info(`${preKeyCount} pre-keys found on server (legacy check)`)
        
        if (preKeyCount <= MIN_PREKEY_COUNT) {
            await this.legacyUploadPreKeys(creds, INITIAL_PREKEY_COUNT)
        }
    }

    private async legacyGetAvailablePreKeysOnServer(): Promise<number> {
        const result = await this.query({
            tag: 'iq',
            attrs: {
                id: this.generateMessageTag(),
                xmlns: 'encrypt',
                type: 'get',
                to: 'g.us'
            },
            content: [{ tag: 'count', attrs: {} }]
        })

        const countChild = result.content?.find((node: any) => node.tag === 'count')
        return parseInt(countChild?.attrs?.value || '0', 10)
    }

    private generateMessageTag(): string {
        return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase()
    }
}

/**
 * Factory function para criar integração de pre-keys
 */
export function createPreKeyIntegration(
    signalStore: SignalKeyStore,
    query: (node: BinaryNode) => Promise<BinaryNode>,
    logger: ILogger,
    config?: Partial<PreKeyIntegrationConfig>
): PreKeyIntegration {
    return new PreKeyIntegration(signalStore, query, logger, config)
}

/**
 * Wrapper functions para compatibilidade com código existente
 */
export function createPreKeyManagerWrappers(integration: PreKeyIntegration, creds: AuthenticationCreds) {
    return {
        uploadPreKeys: async (count?: number) => {
            await integration.uploadPreKeys(creds, count)
        },
        
        uploadPreKeysToServerIfRequired: async () => {
            await integration.uploadPreKeysToServerIfRequired(creds)
        },
        
        getAvailablePreKeysOnServer: async () => {
            return await integration.getAvailablePreKeysOnServer()
        },

        // Funções adicionais do gerenciador avançado
        getStats: () => {
            return integration.getAdvancedStats()
        },

        healthCheck: async () => {
            return await integration.healthCheck()
        },

        resetStats: () => {
            integration.resetStats()
        }
    }
}

/**
 * Utilitário para migração gradual
 */
export class PreKeyMigrationHelper {
    static async migrateToAdvancedManager(
        currentUploadFunction: () => Promise<void>,
        integration: PreKeyIntegration,
        creds: AuthenticationCreds,
        options: {
            testMode: boolean
            validateResults: boolean
        } = { testMode: false, validateResults: true }
    ): Promise<{
        success: boolean
        method: 'advanced' | 'legacy'
        error?: string
        stats?: any
    }> {
        try {
            if (options.testMode) {
                // Em modo de teste, executar ambos e comparar
                const legacyStartTime = Date.now()
                await currentUploadFunction()
                const legacyTime = Date.now() - legacyStartTime

                const advancedStartTime = Date.now()
                await integration.uploadPreKeys(creds)
                const advancedTime = Date.now() - advancedStartTime

                return {
                    success: true,
                    method: 'advanced',
                    stats: {
                        legacyTime,
                        advancedTime,
                        improvement: legacyTime - advancedTime
                    }
                }
            } else {
                // Usar apenas o gerenciador avançado
                await integration.uploadPreKeys(creds)
                
                const stats = integration.getAdvancedStats()
                
                return {
                    success: true,
                    method: 'advanced',
                    stats
                }
            }
        } catch (error) {
            return {
                success: false,
                method: 'legacy',
                error: error.message
            }
        }
    }
}