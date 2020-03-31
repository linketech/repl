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

const AdmZip = require('adm-zip')
const _ = require('lodash')
const Koa = require('koa')
const Router = require('koa-router')
const koaBody = require('koa-body')

const indexHtml = _.template(fs.readFileSync('./template.html'))
const app = new Koa()
const router = new Router()

const sleep = promisify(setTimeout)
cp.execAsync = promisify(cp.exec).bind(cp)

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
		this.cwd = path.join(path.resolve(os.tmpdir()), this.hash)
		this.reloadPackageJson()
	}

	reloadPackageJson() {
		try {
			this.packageJson = JSON.parse(fs.readFileSync(path.join(this.cwd, 'package.json')))
		} catch (e) {
			this.packageJson = { name: this.hash }
		}
	}

	requireModule(moduleName) {
		const [name, version = 'latest'] = moduleName.split('@')
		if (resolve(name)) {
			return require(name)
		}
		const { cwd } = this
		if (!fs.existsSync(cwd)) {
			fs.mkdirSync(cwd, { recursive: true })
			cp.execSync('npm init -y', { cwd })
		}
		const fullPath = path.join(cwd, 'node_modules', name)
		if (!resolve(fullPath)) {
			const content = cp.execSync(`npm i --register=registry.npm.taobao.org ${name}@${version}`, { cwd })
			this.reloadPackageJson()
			this.logs.push({ type: 'output', timestamp: Date.now(), content })
		}
		return require(fullPath)
	}

	async input(script, logScript, wait = 0) {
		// console.log('script' script)
		this.readStream.push(`${script}\n`)
		await sleep(wait)
		const timestamp = Date.now()
		this.logs.push({ type: 'input', timestamp, content: `${logScript || script}\n` })
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
	ctx.body = indexHtml({ repl: theRepl })
})

async function deleteRepl(ctx) {
	const { hash } = ctx.params
	const theRepl = Repl.getInstance(hash)
	await theRepl.input('.exit')
	console.log('delete instance', hash)
	theRepl.clearLogs()
	ctx.body = indexHtml({ repl: theRepl })
	Repl.deleteInstance(hash)
}

router.post('/:hash/npm/install', async (ctx) => {
	const { hash } = ctx.params
	const theRepl = Repl.getInstance(hash)
	const { packageJson } = ctx.request.body
	if (typeof packageJson !== 'object') {
		ctx.status = 400
		return
	}
	console.log('npm install for', hash, JSON.stringify(packageJson))
	const { cwd } = theRepl
	if (!fs.existsSync(cwd)) {
		fs.mkdirSync(cwd, { recursive: true })
		fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(packageJson, null, 4))
	}
	const { stderr, stdout } = await cp.execAsync('npm i --production --register=registry.npm.taobao.org', { cwd })
	if (stderr) {
		theRepl.logs.push({ type: 'output', timestamp: Date.now(), content: stderr })
	}
	if (stdout) {
		theRepl.logs.push({ type: 'output', timestamp: Date.now(), content: stdout })
	}
	theRepl.reloadPackageJson()
	const zip = new AdmZip()
	zip.addLocalFolder(path.join(cwd))
	ctx.body = zip.toBuffer()
})

router.post('/:hash', async (ctx) => {
	const { hash } = ctx.params
	const theRepl = Repl.getInstance(hash)
	const { logScript } = ctx.request.body
	const script = String(ctx.request.body.script).trim()
	console.log('run instance', hash, JSON.stringify(script))
	if (script === '.exit') {
		await deleteRepl(ctx)
		return
	}
	if (script === '.clear') {
		theRepl.clearLogs()
	} else if (script) {
		await theRepl.input(script, logScript)
	}
	ctx.body = indexHtml({ repl: theRepl })
})

router.delete('/:hash', deleteRepl)

app.use(koaBody())
app.use(router.routes())
app.use(router.allowedMethods())

app.listen(8080, () => console.log('Server start'))
