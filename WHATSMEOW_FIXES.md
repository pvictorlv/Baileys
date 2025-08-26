# WhatsApp Meow Critical Fixes

## Problemas Identificados nos Logs

1. **"Maximum retry attempts exceeded for message"** - Sistema de retry muito complexo
2. **"Connection Closed"** - Conexão sendo fechada durante processamento
3. **Grupos mais problemáticos** - Mensagens `skmsg` não tratadas adequadamente

## Diferenças Críticas com WhatsApp Meow

### 1. Sistema de Retry Simplificado
- WhatsApp Meow usa apenas 5 tentativas máximas
- Não usa loops complexos de retry
- Envia retry request e falha imediatamente se não conseguir descriptografar

### 2. Tratamento de Grupos
- Mensagens `skmsg` (sender key messages) têm tratamento especial
- Não deve usar mutex complexo para grupos
- Deve verificar se tem sender key antes de tentar descriptografar

### 3. Request from Phone
- Apenas no primeiro retry
- Não deve bloquear o processamento

## Implementação das Correções

### Correção 1: Simplificar decryptWithRetry
```typescript
// Remover loop complexo, usar padrão WhatsApp Meow
async function decryptWithRetry(...) {
    try {
        return await decryptFn()
    } catch (error) {
        // Send retry request and fail immediately
        if (sendRetryRequestFn && node && isRecoverableDecryptionError(error)) {
            await sendRetryRequestFn(node, shouldIncludeKeys(error))
        }
        throw error
    }
}
```

### Correção 2: Remover Mutex Complexo
- Remover per-message mutex que pode causar deadlock
- Usar padrão mais simples do WhatsApp Meow

### Correção 3: Tratar Grupos Adequadamente
- Verificar se é mensagem de grupo (`skmsg`)
- Tratar `ErrNoSenderKeyForUser` especificamente
- Não aplicar mesmo retry logic para grupos e DMs

### Correção 4: Timeout de Conexão
- Implementar timeout adequado para evitar "Connection Closed"
- Não bloquear processamento por muito tempo