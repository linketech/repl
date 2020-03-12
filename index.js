/* eslint-disable max-classes-per-file, no-underscore-dangle */
const fs = require('fs')
const repl = require('repl')
const crypto = require('crypto')
const { promisify } = require('util')
const { Readable, Writable } = require('stream')

const _ = require('lodash')
const Koa = require('koa')
const Router = require('koa-router')
const koaBody = require('koa-body')

const indexHtml = _.template(fs.readFileSync('./template.html'))
const sleep = promisify(setTimeout)
const app = new Koa()
const router = new Router()

class ReplReadStream extends Readable {
	// eslint-disable-next-line class-methods-use-this
	_read() {}
}

class ReplWriteStream extends Writable {
	constructor(opts, maxLine = 9999) {
		super(opts)
		this.flush()
		this.maxLine = maxLine
	}

	_write(chunk, encoding, next) {
		// console.log('chunk', chunk.toString())
		if (this.content.length < this.maxLine) {
			this.content.push(chunk)
		} else if (this.content.length < this.maxLine + 1) {
			this.content.push(Buffer.from('...'))
		}
		next()
	}

	dump() { return Buffer.concat(this.content).toString() }

	flush() { this.content = [] }
}

class Repl {
	static getInstance(hash) {
		return Repl.instances[hash] || new Repl(hash)
	}

	static deleteInstance(hash) {
		delete Repl.instances[hash]
	}

	constructor(hash) {
		console.log('new instance', hash)
		this.readStream = new ReplReadStream()
		this.writeStream = new ReplWriteStream()
		repl.start({ prompt: '', input: this.readStream, output: this.writeStream, ignoreUndefined: true })
		this.hash = hash
		Repl.instances[this.hash] = this
		this.logs = []
	}

	async input(script, wait = 0) {
		// console.log('script' script)
		this.readStream.push(script)
		this.readStream.push('\n')
		await sleep(wait)
		const timestamp = Date.now()
		this.logs.push({ type: 'input', timestamp, content: script })
		this.fetchOutput(timestamp)
	}

	fetchOutput(timestamp = Date.now()) {
		const output = this.writeStream.dump()
		if (output) {
			this.logs.push({ type: 'output', timestamp, content: output })
			this.writeStream.flush()
		}
	}

	getLogs() {
		this.fetchOutput()
		return this.logs
	}

	clearLogs() {
		this.logs = []
	}
}
Repl.instances = {}

router.get('/', async (ctx) => {
	const hash = crypto.createHash('md5').update(String(Math.random())).digest('hex').substring(8, 24)
	Repl.getInstance(hash)
	console.log('create instance', hash)
	ctx.redirect(hash)
})

router.get('/:hash', async (ctx) => {
	const { hash } = ctx.params
	const theRepl = Repl.getInstance(hash)
	console.log('get instance', hash)
	ctx.body = indexHtml({ logs: theRepl.getLogs() })
})

async function deleteRepl(ctx) {
	const { hash } = ctx.params
	const theRepl = Repl.getInstance(hash)
	await theRepl.input('.exit')
	console.log('delete instance', hash)
	theRepl.clearLogs()
	ctx.body = indexHtml({ logs: theRepl.getLogs() })
	Repl.deleteInstance(hash)
}

router.post('/:hash', async (ctx) => {
	const { hash } = ctx.params
	const theRepl = Repl.getInstance(hash)
	const { script } = ctx.request.body
	console.log('run instance', hash, JSON.stringify(script))
	if (script.trim() === '.exit') {
		await deleteRepl(ctx)
		return
	}
	if (script.trim() === '.clear') {
		theRepl.clearLogs()
	} else if (script) {
		await theRepl.input(script)
	}
	ctx.body = indexHtml({ logs: theRepl.getLogs() })
})


router.delete('/:hash', deleteRepl)

app.use(koaBody())
app.use(router.routes())
app.use(router.allowedMethods())

app.listen(8080, () => console.log('Server start'))
