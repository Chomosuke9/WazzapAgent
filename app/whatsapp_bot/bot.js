const { makeWASocket, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('baileys')
const { useMySQLAuthState } = require('mysql-baileys')
require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env')
});

const host = process.env.HOST;
const port = process.env.SQL_PORT;
const user = process.env.SQL_USER;
const password = process.env.SQL_PASSWORD;
const database = process.env.SQL_DATABASE;

async function startSock(sessionName){
	const { error, version } = await fetchLatestBaileysVersion()

	if (error){
		console.log(`Session: ${sessionName} | No connection, check your internet.`)
		return startSock(sessionName)
	}

	const { state, saveCreds, removeCreds } = await useMySQLAuthState({
		session: sessionName,
		host: host,
		port: port,
		user: user,
		password: password,
		database: database,
		tableName: 'auth',
		isServer: true
	})

	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		version: version,
		defaultQueryTimeoutMs: undefined
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', async({ connection, lastDisconnect }) => {
		// your code here
	})

	sock.ev.on('messages.upsert', async({ messages, type }) => {
		// your code here
	})
}

startSock('session1')