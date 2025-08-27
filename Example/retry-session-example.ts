import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import makeWASocket, { 
	AnyMessageContent, 
	DisconnectReason, 
	fetchLatestBaileysVersion, 
	makeCacheableSignalKeyStore, 
	useMultiFileAuthState 
} from '../src'
import P from 'pino'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./retry-session-logs.txt'))
logger.level = 'debug'

// External map to store retry counts of messages when decryption/encryption fails
const msgRetryCounterCache = new NodeCache()

// Start a connection with retry and session recreation features enabled
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_retry_auth')
	// Fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// Enable the new retry and session recreation features
		enableAutoSessionRecreation: true,
		enableRecentMessageCache: true,
		// Implement to handle retries & poll updates
		getMessage: async (key) => {
			// This would typically fetch from your message store
			// For this example, we'll return undefined to test cache functionality
			logger.debug({ key }, 'getMessage called - would fetch from store')
			return undefined
		},
	})

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update
		if(connection === 'close') {
			const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
			console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect)
			// reconnect if not logged out
			if(shouldReconnect) {
				startSock()
			}
		} else if(connection === 'open') {
			console.log('opened connection')
			
			// Log retry manager stats
			if (sock.messageRetryManager) {
				const stats = sock.messageRetryManager.getCacheStats()
				console.log('Message retry manager initialized:', stats)
			}
		}
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('messages.upsert', async (m) => {
		console.log(JSON.stringify(m, undefined, 2))

		const msg = m.messages[0]
		if (!msg.key.fromMe && m.type === 'notify') {
			console.log('replying to', m.messages[0].key.remoteJid)
			
			// Send a test message to demonstrate retry cache functionality
			const testMessage: AnyMessageContent = {
				text: `Hello! This message will be cached for retry purposes. Sent at ${new Date().toISOString()}`
			}
			
			try {
				await sock.sendMessage(msg.key.remoteJid!, testMessage)
				console.log('Message sent and cached for retry')
				
				// Log cache stats after sending
				if (sock.messageRetryManager) {
					const stats = sock.messageRetryManager.getCacheStats()
					console.log('Cache stats after sending:', stats)
				}
			} catch (error) {
				console.error('Failed to send message:', error)
			}
		}
	})

	// Log retry receipts for debugging
	sock.ev.on('messages.update', (updates) => {
		for (const update of updates) {
			if (update.update.status) {
				console.log(`Message ${update.key.id} status updated to:`, update.update.status)
			}
		}
	})

	return sock
}

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('Shutting down gracefully...')
	process.exit(0)
})

startSock()