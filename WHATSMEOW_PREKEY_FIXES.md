# WhatsApp Meow PreKey Error Handling Implementation

## Overview

This document describes the implementation of WhatsApp Meow-inspired PreKey error handling to fix "PreKeyError: Invalid PreKey ID" issues that were causing message decryption failures and connection closures.

## Problem Analysis

### Original Issues
- **PreKey Errors**: `PreKeyError: Invalid PreKey ID` for `pkmsg` (PreKey message) types
- **Connection Failures**: "Connection Closed" errors after PreKey failures
- **Message Loss**: Failed decryption leading to lost messages
- **Insufficient Retry Logic**: Simple retry requests without session recreation

### Root Cause
The original implementation was sending retry requests but not handling the core issue: when PreKey IDs become invalid, the client needs to:
1. Fetch new PreKeys from the server
2. Recreate the Signal session with the new PreKeys
3. Retry decryption with the fresh session

## WhatsApp Meow Pattern Analysis

Based on analysis of [WhatsApp Meow's implementation](https://github.com/tulir/whatsmeow/):

### Key Files Analyzed
- `message.go`: Main decryption logic with PreKey error handling
- `retry.go`: Retry receipt handling with session recreation
- `prekeys.go`: PreKey fetching and management

### WhatsApp Meow PreKey Handling Pattern
1. **Error Detection**: Identify PreKey-related errors during decryption
2. **Session Recreation Logic**: Check if session recreation is needed based on:
   - Retry count > 1
   - Time since last recreation > 1 hour
3. **PreKey Fetching**: Fetch new PreKeys from server using `fetchPreKeys()`
4. **Session Clearing**: Delete existing session to force recreation
5. **Retry with New Session**: Attempt decryption with fresh session

## Implementation

### New Files Created

#### 1. `whatsmeow-prekey-handler.ts`
**Purpose**: Core PreKey error handling logic

**Key Functions**:
- `isPreKeyError()`: Detects PreKey-related errors
- `handlePreKeyError()`: Manages session recreation logic
- `decryptWithPreKeyHandling()`: Enhanced decryption with PreKey support
- `shouldRecreateSession()`: WhatsApp Meow recreation timing logic

**Features**:
- Session recreation history tracking (1-hour timeout)
- Limited retry attempts (max 2 for PreKey errors)
- Comprehensive error analysis and logging

#### 2. Enhanced `whatsmeow-simple-decrypt.ts`
**Improvements**:
- Added PreKey handling parameters to `simpleDecryptWithRetry()`
- Special handling for `pkmsg` message types
- Integration with PreKey error detection
- Force include keys for PreKey errors in retry requests

### Modified Files

#### 1. `decode-wa-message.ts`
**Changes**:
- Added PreKey function factories for each decryption context
- `createFetchPreKeysFn()`: Creates PreKey fetching function with proper context
- `createRecreateSessionFn()`: Creates session recreation function
- Integrated PreKey functions into `simpleDecryptWithRetry()` calls

**WhatsApp Meow Pattern Implementation**:
```typescript
// Create PreKey handling functions for WhatsApp Meow pattern
const createFetchPreKeysFn = (targetJid: string) => async (jid: string): Promise<boolean> => {
    return await fetchPreKeys([jid], sessionContext?.query, repository, logger)
}

const createRecreateSessionFn = (targetJid: string) => async (jid: string): Promise<boolean> => {
    // WhatsApp Meow pattern: Delete existing session and let it be recreated
    const signalId = repository.jidToSignalProtocolAddress(jid)
    await sessionContext?.authState?.keys?.set?.({ 'session': { [signalId]: null } })
    return true
}
```

## Technical Details

### PreKey Error Detection
```typescript
function isPreKeyError(error: any): boolean {
    const message = error.message.toLowerCase()
    return message.includes('prekey') && 
           (message.includes('invalid') || message.includes('not found') || message.includes('id'))
}
```

### Session Recreation Logic (WhatsApp Meow Pattern)
```typescript
function shouldRecreateSession(senderJid: string, retryCount: number): { recreate: boolean; reason: string } {
    // Only recreate if retry count > 1 and over an hour since last recreation
    if (retryCount < 2) return { recreate: false, reason: '' }
    
    const now = Date.now()
    const lastRecreation = sessionRecreationHistory.get(senderJid) || 0
    
    if (now - lastRecreation > RECREATION_TIMEOUT) {
        sessionRecreationHistory.set(senderJid, now)
        return { recreate: true, reason: 'retry count > 1 and over an hour since last recreation' }
    }
    
    return { recreate: false, reason: 'recently recreated session' }
}
```

### Enhanced Decryption Flow
1. **First Attempt**: Try normal decryption
2. **Error Analysis**: Check if it's a PreKey error
3. **Session Recreation**: If needed, fetch new PreKeys and clear session
4. **Retry**: Attempt decryption with fresh session (max 2 attempts)
5. **Fallback**: Send retry request and fail gracefully

## Benefits

### Immediate Improvements
- **PreKey Error Resolution**: Proper handling of "Invalid PreKey ID" errors
- **Session Recovery**: Automatic session recreation with fresh PreKeys
- **Reduced Connection Failures**: Fewer "Connection Closed" errors
- **Better Message Delivery**: Improved success rate for `pkmsg` messages

### Long-term Stability
- **WhatsApp Meow Compatibility**: Following proven patterns from Go implementation
- **Robust Error Handling**: Comprehensive error analysis and recovery
- **Performance Optimization**: Limited retries prevent infinite loops
- **Logging Enhancement**: Detailed logging for debugging and monitoring

## Configuration

### Timeouts and Limits
```typescript
const RECREATION_TIMEOUT = 60 * 60 * 1000 // 1 hour (WhatsApp Meow pattern)
const maxRetries = 2 // Limited retries for PreKey errors
```

### Error Types Handled
- `PreKeyError: Invalid PreKey ID`
- `PreKey not found`
- `Invalid PreKey`
- Any error containing "prekey" + "invalid"/"not found"/"id"

## Testing

### Compilation
- ✅ TypeScript compilation passes without errors
- ✅ All imports and types resolved correctly
- ✅ Integration with existing codebase verified

### Expected Behavior
1. **PreKey Error Detection**: Errors are properly identified and logged
2. **Session Recreation**: New PreKeys fetched and sessions cleared
3. **Retry Logic**: Limited retries with proper timing
4. **Fallback**: Graceful failure with retry requests sent

## Monitoring

### Key Log Messages
- `"PreKey error detected during decryption"`
- `"Attempting to fetch new PreKeys and recreate session"`
- `"Successfully recreated session with new PreKeys"`
- `"Retrying decryption after PreKey session recreation"`

### Metrics to Track
- PreKey error frequency
- Session recreation success rate
- Message decryption success rate after PreKey fixes
- Connection stability improvements

## Future Enhancements

### Potential Improvements
1. **Metrics Collection**: Add detailed metrics for PreKey error patterns
2. **Adaptive Timeouts**: Dynamic timeout adjustment based on error patterns
3. **Batch PreKey Fetching**: Optimize PreKey requests for multiple contacts
4. **Error Recovery Strategies**: Additional recovery mechanisms for edge cases

### Maintenance
- **Session History Cleanup**: Automatic cleanup of old session recreation history
- **Performance Monitoring**: Track PreKey handling performance impact
- **Error Pattern Analysis**: Monitor for new error types requiring handling

## Conclusion

This implementation brings Baileys' PreKey error handling in line with WhatsApp Meow's proven approach, providing robust recovery from PreKey-related decryption failures. The solution addresses the root cause of "Invalid PreKey ID" errors while maintaining compatibility with existing code and following established patterns from the Go implementation.