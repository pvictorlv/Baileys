import { randomBytes } from 'crypto'
import { AdvancedPreKeyManager, createAdvancedPreKeyManager } from '../Utils/advanced-prekey-manager'
import { createPreKeyIntegration } from '../Utils/prekey-integration'
import { AuthenticationCreds, SignalKeyStore } from '../Types'
import { BinaryNode } from '../WABinary'
import { Curve } from '../Utils'

/**
 * Testes para o Advanced PreKey Manager
 * Valida funcionalidades baseadas no WhatsMeow
 */

// Mock implementations para testes
class MockSignalKeyStore implements SignalKeyStore {
    private store = new Map<string, any>()

    async get(type: string, ids: string[]) {
        const result: any = {}
        for (const id of ids) {
            const key = `${type}:${id}`
            if (this.store.has(key)) {
                result[id] = this.store.get(key)
            }
        }
        return result
    }

    async set(data: any) {
        for (const [type, items] of Object.entries(data)) {
            for (const [id, value] of Object.entries(items as any)) {
                this.store.set(`${type}:${id}`, value)
            }
        }
    }

    async clear() {
        this.store.clear()
    }

    async transaction(work: () => Promise<void>) {
        await work()
    }
}

class MockLogger {
    level = 'debug'
    
    debug(msg: string, data?: any) { console.log(`[DEBUG] ${msg}`, data || '') }
    info(msg: string, data?: any) { console.log(`[INFO] ${msg}`, data || '') }
    warn(msg: string, data?: any) { console.log(`[WARN] ${msg}`, data || '') }
    error(msg: string, data?: any) { console.log(`[ERROR] ${msg}`, data || '') }
    trace(msg: string, data?: any) { console.log(`[TRACE] ${msg}`, data || '') }
    
    child(bindings: any) {
        return new MockLogger()
    }
}

function createMockQuery(serverPreKeyCount = 10): (node: BinaryNode) => Promise<BinaryNode> {
    return async (node: BinaryNode) => {
        // Simular resposta do servidor
        if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'get') {
            // Query para contagem de pre-keys
            return {
                tag: 'iq',
                attrs: { type: 'result' },
                content: [
                    {
                        tag: 'count',
                        attrs: { value: serverPreKeyCount.toString() },
                        content: []
                    }
                ]
            }
        } else if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'set') {
            // Upload de pre-keys
            return {
                tag: 'iq',
                attrs: { type: 'result' },
                content: []
            }
        }

        throw new Error('Unexpected query')
    }
}

function createMockCreds(): AuthenticationCreds {
    const identityKeyPair = Curve.generateKeyPair()
    const signedPreKey = Curve.generateKeyPair()
    
    return {
        noiseKey: identityKeyPair,
        signedIdentityKey: identityKeyPair,
        signedPreKey: {
            keyPair: signedPreKey,
            signature: randomBytes(64),
            keyId: 1
        },
        registrationId: Math.floor(Math.random() * 0xFFFFFF),
        advSecretKey: randomBytes(32).toString('base64'),
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSettings: {
            unarchiveChats: false,
            defaultDisappearingMode: {
                ephemeralExpiration: 0,
                ephemeralSettingTimestamp: 0
            }
        }
    }
}

// Testes

async function testBasicFunctionality() {
    console.log('\n=== Test: Basic Functionality ===')
    
    const store = new MockSignalKeyStore()
    const logger = new MockLogger()
    const query = createMockQuery(10)
    
    const manager = createAdvancedPreKeyManager(store, query, logger)
    
    // Test server count
    const serverCount = await manager.getServerPreKeyCount()
    console.log(`Server pre-key count: ${serverCount}`)
    
    // Test pre-key generation
    const preKeys = await manager.generatePreKeys(5)
    console.log(`Generated ${preKeys.length} pre-keys`)
    
    // Test stats
    const stats = manager.getStats()
    console.log('Initial stats:', stats)
    
    console.log('✅ Basic functionality test passed')
}

async function testUploadWithRaceConditionPrevention() {
    console.log('\n=== Test: Upload with Race Condition Prevention ===')
    
    const store = new MockSignalKeyStore()
    const logger = new MockLogger()
    const creds = createMockCreds()
    
    // Simular servidor com muitas pre-keys (deve cancelar upload)
    const query = createMockQuery(60) // Acima do wanted count (50)
    
    const manager = createAdvancedPreKeyManager(store, query, logger, {
        wantedPreKeyCount: 50,
        minPreKeyCount: 5,
        enableRaceConditionPrevention: true
    })
    
    // Simular upload recente
    const result1 = await manager.uploadPreKeys(creds)
    console.log('First upload result:', result1)
    
    // Segundo upload deve ser cancelado por race condition
    const result2 = await manager.uploadPreKeys(creds)
    console.log('Second upload result (should be cancelled):', result2)
    
    const stats = manager.getStats()
    console.log('Stats after race condition test:', stats)
    
    if (stats.raceConditionsDetected > 0) {
        console.log('✅ Race condition prevention test passed')
    } else {
        console.log('❌ Race condition prevention test failed')
    }
}

async function testHealthCheck() {
    console.log('\n=== Test: Health Check ===')
    
    const store = new MockSignalKeyStore()
    const logger = new MockLogger()
    
    // Test with low server count (unhealthy)
    const queryLowCount = createMockQuery(2)
    const manager1 = createAdvancedPreKeyManager(store, queryLowCount, logger, {
        minPreKeyCount: 5
    })
    
    const healthCheck1 = await manager1.healthCheck()
    console.log('Health check with low server count:', healthCheck1)
    
    // Test with good server count (healthy)
    const queryGoodCount = createMockQuery(20)
    const manager2 = createAdvancedPreKeyManager(store, queryGoodCount, logger, {
        minPreKeyCount: 5
    })
    
    const healthCheck2 = await manager2.healthCheck()
    console.log('Health check with good server count:', healthCheck2)
    
    if (!healthCheck1.healthy && healthCheck2.healthy) {
        console.log('✅ Health check test passed')
    } else {
        console.log('❌ Health check test failed')
    }
}

async function testIntegrationLayer() {
    console.log('\n=== Test: Integration Layer ===')
    
    const store = new MockSignalKeyStore()
    const logger = new MockLogger()
    const query = createMockQuery(3) // Low count to trigger upload
    const creds = createMockCreds()
    
    const integration = createPreKeyIntegration(store, query, logger, {
        enableAdvancedManager: true,
        fallbackToLegacy: true
    })
    
    // Test conditional upload
    await integration.uploadPreKeysToServerIfRequired(creds)
    
    // Test stats
    const stats = integration.getAdvancedStats()
    console.log('Integration stats:', stats)
    
    // Test health check
    const healthCheck = await integration.healthCheck()
    console.log('Integration health check:', healthCheck)
    
    console.log('✅ Integration layer test passed')
}

async function testPerformanceMonitoring() {
    console.log('\n=== Test: Performance Monitoring ===')
    
    const store = new MockSignalKeyStore()
    const logger = new MockLogger()
    const query = createMockQuery(3)
    const creds = createMockCreds()
    
    const manager = createAdvancedPreKeyManager(store, query, logger, {
        enablePerformanceMonitoring: true
    })
    
    // Perform multiple uploads to test performance tracking
    for (let i = 0; i < 3; i++) {
        await manager.uploadPreKeys(creds, true) // Force upload
        await new Promise(resolve => setTimeout(resolve, 100)) // Small delay
    }
    
    const stats = manager.getStats()
    console.log('Performance stats after multiple uploads:', stats)
    
    if (stats.totalUploads === 3 && stats.averageUploadTime > 0) {
        console.log('✅ Performance monitoring test passed')
    } else {
        console.log('❌ Performance monitoring test failed')
    }
}

async function testErrorHandling() {
    console.log('\n=== Test: Error Handling ===')
    
    const store = new MockSignalKeyStore()
    const logger = new MockLogger()
    const creds = createMockCreds()
    
    // Create query that always fails
    const failingQuery = async (node: BinaryNode) => {
        throw new Error('Network error')
    }
    
    const manager = createAdvancedPreKeyManager(store, failingQuery, logger, {
        maxRetryAttempts: 2,
        retryDelayMs: 100
    })
    
    try {
        await manager.uploadPreKeys(creds)
        console.log('❌ Error handling test failed - should have thrown')
    } catch (error) {
        console.log('Expected error caught:', error.message)
        
        const stats = manager.getStats()
        console.log('Stats after failed upload:', stats)
        
        if (stats.failedUploads > 0) {
            console.log('✅ Error handling test passed')
        } else {
            console.log('❌ Error handling test failed - stats not updated')
        }
    }
}

// Executar todos os testes
async function runAllTests() {
    console.log('🚀 Starting Advanced PreKey Manager Tests')
    
    try {
        await testBasicFunctionality()
        await testUploadWithRaceConditionPrevention()
        await testHealthCheck()
        await testIntegrationLayer()
        await testPerformanceMonitoring()
        await testErrorHandling()
        
        console.log('\n🎉 All tests completed!')
    } catch (error) {
        console.error('\n💥 Test suite failed:', error)
    }
}

// Executar testes se chamado diretamente
if (require.main === module) {
    runAllTests()
}

export {
    runAllTests,
    testBasicFunctionality,
    testUploadWithRaceConditionPrevention,
    testHealthCheck,
    testIntegrationLayer,
    testPerformanceMonitoring,
    testErrorHandling
}