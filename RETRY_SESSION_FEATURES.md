# Recursos de Retry e Recriação de Sessões

Este documento descreve as novas funcionalidades implementadas no Baileys baseadas no whatsmeow para melhorar a confiabilidade das mensagens através de recriação automática de sessões inválidas e cache de mensagens recentes para retry.

## Funcionalidades Implementadas

### 1. Cache de Mensagens Recentes para Retry

O sistema agora mantém um cache circular das últimas 256 mensagens enviadas para permitir reenvio eficiente quando solicitado pelo WhatsApp.

**Características:**
- Cache circular de 256 mensagens por JID
- Armazenamento automático de mensagens enviadas
- Recuperação rápida para retry requests
- Limpeza automática de mensagens antigas

### 2. Recriação Automática de Sessões Inválidas

O sistema detecta automaticamente quando uma sessão está corrompida ou inválida e a recria para restaurar a comunicação.

**Características:**
- Detecção automática de sessões problemáticas
- Recriação baseada em contadores de retry
- Histórico de recriações para evitar loops
- Timeout de 1 hora entre recriações para o mesmo JID

## Configuração

Para habilitar essas funcionalidades, configure o socket com as seguintes opções:

```typescript
import makeWASocket from '@whiskeysockets/baileys'

const sock = makeWASocket({
    // ... outras configurações
    
    // Habilita recriação automática de sessões inválidas
    enableAutoSessionRecreation: true,
    
    // Habilita cache de mensagens recentes para retry
    enableRecentMessageCache: true,
})
```

## Como Funciona

### Cache de Mensagens

1. **Armazenamento**: Toda mensagem enviada é automaticamente armazenada no cache
2. **Recuperação**: Quando o WhatsApp solicita um retry, o sistema primeiro verifica o cache
3. **Fallback**: Se não encontrada no cache, usa o método `getMessage` tradicional
4. **Limpeza**: Mensagens antigas são automaticamente removidas do cache

### Recriação de Sessões

1. **Detecção**: O sistema monitora retry requests e falhas de sessão
2. **Análise**: Determina se a sessão deve ser recriada baseado em:
   - Número de tentativas de retry
   - Existência de sessão válida
   - Histórico de recriações recentes
3. **Recriação**: Remove a sessão corrompida e força criação de nova sessão
4. **Prevenção**: Evita recriações excessivas através de timeout

## Logs e Monitoramento

O sistema gera logs detalhados para monitoramento:

```typescript
// Logs de cache
logger.debug({ jid, id }, 'found message in retry cache')
logger.debug(stats, 'cleaned up retry manager caches')

// Logs de recriação de sessão
logger.info({ fromJid, retryCount, reason }, 'recreating session for retry')
logger.warn({ error, fromJid }, 'failed to check session recreation')
```

## Estatísticas do Cache

Você pode obter estatísticas do cache em tempo real:

```typescript
if (sock.messageRetryManager) {
    const stats = sock.messageRetryManager.getCacheStats()
    console.log('Cache stats:', stats)
    // Output: { totalMessages: 150, totalJids: 25, oldestMessage: '2024-01-01T10:00:00Z' }
}
```

## Exemplo de Uso

Veja o arquivo `Example/retry-session-example.ts` para um exemplo completo de como usar essas funcionalidades.

## Benefícios

1. **Maior Confiabilidade**: Mensagens são reenviadas mais eficientemente
2. **Recuperação Automática**: Sessões corrompidas são automaticamente corrigidas
3. **Melhor Performance**: Cache reduz latência em retry requests
4. **Menos Falhas**: Detecção proativa de problemas de sessão

## Compatibilidade

- ✅ Totalmente compatível com código existente
- ✅ Funcionalidades opcionais (desabilitadas por padrão)
- ✅ Não quebra APIs existentes
- ✅ Funciona com todos os tipos de mensagem

## Configurações Avançadas

As funcionalidades podem ser configuradas através das seguintes opções:

```typescript
// Configurações padrão (podem ser customizadas)
const config = {
    enableAutoSessionRecreation: true,    // Habilita recriação de sessões
    enableRecentMessageCache: true,       // Habilita cache de mensagens
    // Outras configurações...
}
```

## Troubleshooting

### Cache não está funcionando
- Verifique se `enableRecentMessageCache` está `true`
- Confirme que mensagens estão sendo enviadas através do `relayMessage`

### Sessões não estão sendo recriadas
- Verifique se `enableAutoSessionRecreation` está `true`
- Confirme que há retry requests sendo recebidos
- Verifique logs para mensagens de erro

### Performance
- O cache é limitado a 256 mensagens por JID para evitar uso excessivo de memória
- Limpeza automática ocorre a cada 30 minutos
- Sessões são recriadas no máximo uma vez por hora por JID