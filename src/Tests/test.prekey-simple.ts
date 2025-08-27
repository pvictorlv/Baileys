/**
 * Teste simples para validar o Advanced PreKey Manager
 */

import { AdvancedPreKeyManager } from '../Utils/advanced-prekey-manager'
import { BinaryNode } from '../WABinary'

// Mock simples para testes
class SimpleLogger {
    level = 'debug'
    debug(msg: string, data?: any) { console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data) : '') }
    info(msg: string, data?: any) { console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : '') }
    warn(msg: string, data?: any) { console.log(`[WARN] ${msg}`, data ? JSON.stringify(data) : '') }
    error(msg: string, data?: any) { console.log(`[ERROR] ${msg}`, data ? JSON.stringify(data) : '') }
    trace(msg: string, data?: any) { console.log(`[TRACE] ${msg}`, data ? JSON.stringify(data) : '') }
    child(bindings: any) { return new SimpleLogger() }
}

class SimpleStore {
    private data = new Map()
    
    async get(type: string, ids: string[]) {
        const result: any = {}
        for (const id of ids) {
            const key = `${type}:${id}`
            if (this.data.has(key)) {
                result[id] = this.data.get(key)
            }
        }
        return result
    }

    async set(data: any) {
        for (const [type, items] of Object.entries(data)) {
            for (const [id, value] of Object.entries(items as any)) {
                this.data.set(`${type}:${id}`, value)
            }
        }
    }

    async clear() {
        this.data.clear()
    }

    async transaction(work: () => Promise<void>) {
        await work()
    }
}

function createMockQuery(serverCount = 10) {
    return async (node: BinaryNode) => {
        if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'get') {
            return {
                tag: 'iq',
                attrs: { type: 'result' },
                content: [
                    {
                        tag: 'count',
                        attrs: { value: serverCount.toString() },
                        content: []
                    }
                ]
            }
        } else if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'set') {
            return {
                tag: 'iq',
                attrs: { type: 'result' },
                content: []
            }
        }
        throw new Error('Unexpected query')
    }
}

async function testBasicFunctionality() {
    console.log('\n=== Teste: Funcionalidade Básica ===')
    
    const store = new SimpleStore()
    const logger = new SimpleLogger()
    const query = createMockQuery(10)
    
    const manager = new AdvancedPreKeyManager(store as any, query, logger as any)
    
    try {
        // Testar contagem do servidor
        const serverCount = await manager.getServerPreKeyCount()
        console.log(`✅ Contagem do servidor: ${serverCount}`)
        
        // Testar geração de pre-keys
        const preKeys = await manager.generatePreKeys(5)
        console.log(`✅ Geradas ${preKeys.length} pre-keys`)
        
        // Testar estatísticas
        const stats = manager.getStats()
        console.log(`✅ Estatísticas obtidas:`, stats)
        
        console.log('✅ Teste de funcionalidade básica PASSOU')
        return true
    } catch (error) {
        console.log('❌ Teste de funcionalidade básica FALHOU:', error.message)
        return false
    }
}

async function testHealthCheck() {
    console.log('\n=== Teste: Health Check ===')
    
    const store = new SimpleStore()
    const logger = new SimpleLogger()
    
    try {
        // Teste com contagem baixa (não saudável)
        const queryLow = createMockQuery(2)
        const manager1 = new AdvancedPreKeyManager(store as any, queryLow, logger as any, {
            minPreKeyCount: 5
        })
        
        const health1 = await manager1.healthCheck()
        console.log(`Health check com contagem baixa:`, health1)
        
        // Teste com contagem boa (saudável)
        const queryGood = createMockQuery(20)
        const manager2 = new AdvancedPreKeyManager(store as any, queryGood, logger as any, {
            minPreKeyCount: 5
        })
        
        const health2 = await manager2.healthCheck()
        console.log(`Health check com contagem boa:`, health2)
        
        if (!health1.healthy && health2.healthy) {
            console.log('✅ Teste de health check PASSOU')
            return true
        } else {
            console.log('❌ Teste de health check FALHOU')
            return false
        }
    } catch (error) {
        console.log('❌ Teste de health check FALHOU:', error.message)
        return false
    }
}

async function testServerCountChecking() {
    console.log('\n=== Teste: Verificação de Contagem do Servidor ===')
    
    const store = new SimpleStore()
    const logger = new SimpleLogger()
    
    try {
        const testCounts = [0, 5, 10, 25, 50, 100]
        
        for (const count of testCounts) {
            const query = createMockQuery(count)
            const manager = new AdvancedPreKeyManager(store as any, query, logger as any)
            
            const serverCount = await manager.getServerPreKeyCount()
            
            if (serverCount === count) {
                console.log(`✅ Contagem ${count} verificada corretamente`)
            } else {
                console.log(`❌ Contagem ${count} falhou: obtido ${serverCount}`)
                return false
            }
        }
        
        console.log('✅ Teste de verificação de contagem PASSOU')
        return true
    } catch (error) {
        console.log('❌ Teste de verificação de contagem FALHOU:', error.message)
        return false
    }
}

async function testPreKeyGeneration() {
    console.log('\n=== Teste: Geração de Pre-Keys ===')
    
    const store = new SimpleStore()
    const logger = new SimpleLogger()
    const query = createMockQuery(10)
    
    try {
        const manager = new AdvancedPreKeyManager(store as any, query, logger as any)
        
        const testCounts = [1, 5, 10, 25, 50]
        
        for (const count of testCounts) {
            const preKeys = await manager.generatePreKeys(count)
            
            if (preKeys.length === count) {
                console.log(`✅ Geradas ${count} pre-keys corretamente`)
                
                // Verificar se todas têm keyId e keyPair
                const allValid = preKeys.every(pk => 
                    typeof pk.keyId === 'number' && 
                    pk.keyPair && 
                    pk.keyPair.public && 
                    pk.keyPair.private
                )
                
                if (allValid) {
                    console.log(`✅ Todas as ${count} pre-keys são válidas`)
                } else {
                    console.log(`❌ Algumas pre-keys de ${count} são inválidas`)
                    return false
                }
            } else {
                console.log(`❌ Geração de ${count} pre-keys falhou: obtidas ${preKeys.length}`)
                return false
            }
        }
        
        console.log('✅ Teste de geração de pre-keys PASSOU')
        return true
    } catch (error) {
        console.log('❌ Teste de geração de pre-keys FALHOU:', error.message)
        return false
    }
}

async function runAllTests() {
    console.log('🚀 Iniciando Testes do Advanced PreKey Manager')
    console.log('=' .repeat(50))
    
    const tests = [
        testBasicFunctionality,
        testHealthCheck,
        testServerCountChecking,
        testPreKeyGeneration
    ]
    
    let passed = 0
    let failed = 0
    
    for (const test of tests) {
        try {
            const result = await test()
            if (result) {
                passed++
            } else {
                failed++
            }
        } catch (error) {
            console.log(`❌ Teste falhou com exceção: ${error.message}`)
            failed++
        }
    }
    
    console.log('\n' + '=' .repeat(50))
    console.log(`📊 Resultados dos Testes:`)
    console.log(`✅ Passou: ${passed}`)
    console.log(`❌ Falhou: ${failed}`)
    console.log(`📈 Taxa de Sucesso: ${((passed / (passed + failed)) * 100).toFixed(1)}%`)
    
    if (failed === 0) {
        console.log('\n🎉 Todos os testes PASSARAM! O Advanced PreKey Manager está funcionando corretamente.')
    } else {
        console.log('\n⚠️  Alguns testes falharam. Verifique os logs acima para detalhes.')
    }
    
    return failed === 0
}

// Executar testes se chamado diretamente
if (require.main === module) {
    runAllTests().then(success => {
        process.exit(success ? 0 : 1)
    })
}

export { runAllTests }