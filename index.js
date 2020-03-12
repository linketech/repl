/* eslint-disable import/no-dynamic-require, global-require */
/* eslint-disable max-classes-per-file, no-underscore-dangle */
const cp = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')
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

function resolve(name) {
	try {
		require.resolve(name)
		return true
	} catch (e) {
		return false
	}
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
		const r = repl.start({ prompt: '', input: this.readStream, output: this.writeStream, ignoreUndefined: true })
		r.context.require = this.requireModule.bind(this)
		r.context.require.resolve = require.resolve.bind(require)
		this.hash = hash
		Repl.instances[this.hash] = this
		this.logs = []
	}

	requireModule(name) {
		if (resolve(name)) {
			return require(name)
		}
		const cwd = path.join(path.resolve(os.tmpdir()), this.hash)
		if (!fs.existsSync(cwd)) {
			fs.mkdirSync(cwd, { recursive: true })
			cp.execSync('npm init -y', { cwd })
		}
		const fullPath = path.join(cwd, 'node_modules', name)
		if (!resolve(fullPath)) {
			const content = cp.execSync(`npm i --register=registry.npm.taobao.org ${name}`, { cwd })
			this.logs.push({ type: 'output', timestamp: Date.now(), content })
		}
		return require(fullPath)
	}

	async input(script, wait = 0) {
		// console.log('script' script)
		const content = `${script}\n`
		this.readStream.push(content)
		await sleep(wait)
		const timestamp = Date.now()
		this.logs.push({ type: 'input', timestamp, content })
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
	const script = String(ctx.request.body.script).trim()
	console.log('run instance', hash, JSON.stringify(script))
	if (script === '.exit') {
		await deleteRepl(ctx)
		return
	}
	if (script === '.clear') {
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
