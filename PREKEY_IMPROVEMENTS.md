# Melhorias no Sistema de PreKeys e Descriptografia

## Problema Identificado

O erro "Invalid PreKey ID" estava causando falhas na descriptografia de mensagens, especialmente em grupos, levando à perda de mensagens. O problema principal era que este erro não estava sendo tratado como recuperável, impedindo o sistema de retry automático.

## Análise Comparativa com whatsmeow

Após análise do código do whatsmeow (implementação Go do WhatsApp), foram identificadas várias melhorias que poderiam ser aplicadas ao Baileys:

### Problemas no Baileys Original:
1. **"Invalid PreKey ID" não era tratado como erro recuperável**
2. **Falta de verificação proativa de sessão**
3. **Sistema de retry menos robusto**
4. **Potenciais race conditions em descriptografia simultânea**

### Melhorias do whatsmeow:
1. **Verificação de sessão antes da descriptografia**
2. **Gestão inteligente de prekeys**
3. **Controle de retry baseado em tempo e contador**
4. **Proteção contra race conditions**

## Melhorias Implementadas

### 1. Tratamento de Erros de PreKey como Recuperáveis

**Arquivo:** `src/Utils/decode-wa-message.ts`

```typescript
// Adicionado novo tipo de erro
prekeyErrors: ['Invalid PreKey ID', 'PreKey not found', 'Invalid PreKey', 'PreKey ID not found'],

// Incluído na lista de erros recuperáveis
allRecoverableErrors: [
    // ... outros erros ...
    'Invalid PreKey ID',
    'PreKey not found',
    'Invalid PreKey',
    'PreKey ID not found'
]
```

**Benefício:** Agora quando ocorre "Invalid PreKey ID", o sistema automaticamente tenta recuperar através de retry e fetch de novas prekeys.

### 2. Nova Função de Verificação de Erros de PreKey

```typescript
export function isPreKeyError(error: any): boolean {
    const errorMessage = error?.message || error?.toString() || ''
    return DECRYPTION_RETRY_CONFIG.prekeyErrors.some(errorPattern => errorMessage.includes(errorPattern))
}
```

**Benefício:** Permite classificação específica de erros de prekey para tratamento adequado.

### 3. Verificação de Sessão Proativa

**Arquivo:** `src/Types/Signal.ts` e `src/Signal/libsignal.ts`

```typescript
// Nova função no SignalRepository
hasSession(jid: string): Promise<boolean>

// Implementação
async hasSession(jid: string) {
    try {
        const addr = jidToSignalProtocolAddress(jid)
        const session = await storage.loadSession(addr.toString())
        return session !== null && session.haveOpenSession()
    } catch (error) {
        return false
    }
}
```

**Benefício:** Permite verificar se existe uma sessão válida antes de tentar descriptografar, evitando erros desnecessários.

### 4. Proteção Contra Race Conditions

```typescript
// Mutex por JID para evitar descriptografia simultânea
const decryptionMutexes = new Map<string, Promise<void>>()
const decryptionMutexResolvers = new Map<string, () => void>()

async function acquireDecryptionMutex(jid: string): Promise<() => void> {
    const existingMutex = decryptionMutexes.get(jid)
    if (existingMutex) {
        await existingMutex
    }
    
    let resolver: () => void
    const mutex = new Promise<void>((resolve) => {
        resolver = resolve
    })
    
    decryptionMutexes.set(jid, mutex)
    decryptionMutexResolvers.set(jid, resolver!)
    
    return () => {
        decryptionMutexes.delete(jid)
        decryptionMutexResolvers.delete(jid)
        resolver!()
    }
}
```

**Benefício:** Evita que múltiplas mensagens do mesmo remetente sejam processadas simultaneamente, prevenindo race conditions.

### 5. Classificação Melhorada de Erros

```typescript
// Classificação mais específica de tipos de erro
const errorType = isMacError(error) ? 'MAC' : 
    isSessionRecordError(error) ? 'Session Record' : 
    isPreKeyError(error) ? 'PreKey' : 'Other Recoverable'
```

**Benefício:** Logs mais informativos e tratamento específico para cada tipo de erro.

### 6. Inclusão Inteligente de Keys em Retry

```typescript
// Força inclusão de keys para erros de prekey
const forceIncludeKeys = isSessionRecordError(error) || isMacError(error) || isPreKeyError(error) || recreate || currentRetryCount > 1
```

**Benefício:** Garante que novas prekeys sejam enviadas quando necessário, especialmente para erros de "Invalid PreKey ID".

## Fluxo de Recuperação Melhorado

### Antes:
1. Mensagem chega
2. Tentativa de descriptografia
3. Erro "Invalid PreKey ID"
4. **Falha permanente** - mensagem perdida

### Depois:
1. Mensagem chega
2. **Mutex adquirido** para o remetente
3. Tentativa de descriptografia
4. Erro "Invalid PreKey ID" **detectado como recuperável**
5. **Retry automático** com fetch de novas prekeys
6. **Inclusão forçada de keys** no retry request
7. **Recriação de sessão** se necessário
8. Nova tentativa de descriptografia
9. **Sucesso** ou falha após limite de tentativas
10. **Mutex liberado**

## Configurações Inspiradas no whatsmeow

```typescript
export const DECRYPTION_RETRY_CONFIG = {
    maxRetries: 5, // Mesmo limite do whatsmeow
    baseDelayMs: 100,
    sessionRecreateTimeout: 60 * 60 * 1000, // 1 hora (mesmo do whatsmeow)
    requestFromPhoneDelay: 5000, // 5 segundos
    // ... configurações de erro ...
}
```

## Benefícios Esperados

1. **Redução significativa de mensagens perdidas** por erros de prekey
2. **Melhor estabilidade** em grupos com muitos participantes
3. **Recuperação automática** de problemas de sessão
4. **Prevenção de race conditions** em cenários de alta concorrência
5. **Logs mais informativos** para debugging
6. **Compatibilidade mantida** com código existente

## Compatibilidade

Todas as melhorias são **backward-compatible** e não quebram a API existente. O comportamento padrão permanece o mesmo, mas com melhor tratamento de erros e recuperação automática.

## Monitoramento

Para monitorar a eficácia das melhorias, observe os logs para:

- Mensagens com `errorType: 'PreKey'`
- Sucessos após retry com `session recreation completed successfully`
- Redução de mensagens com `Non-recoverable decryption error`

## Próximos Passos Recomendados

1. **Teste em ambiente de produção** com monitoramento ativo
2. **Coleta de métricas** sobre taxa de sucesso de retry
3. **Ajuste fino** dos timeouts se necessário
4. **Implementação de alertas** para falhas persistentes