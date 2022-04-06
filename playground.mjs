import {fetch, Response} from 'native-fetch'
import {
	ReadableStream,
	WritableStream,
	TransformStream,
	ByteLengthQueuingStrategy,
} from 'node:stream/web'
import fastify from 'fastify'
import stream from 'stream'
import delay from 'delay'

class TimeoutStream extends stream.Readable {
	constructor(size, speed, requestTimeout = 0, timeouts) {
		super()
		this.size = size
		this.requestTimeout = requestTimeout
		this.timeouts = [...timeouts].sort(
			(a, b) => (a.after || 0) - (b.after || 0)
		)
		this._transferred = 0
		this.speed = speed
	}
	async _read(chunkSize) {
		// if (this.requestTimeout) {
		// 	await delay(this.requestTimeout)
		// 	this.requestTimeout = 0
		// }
		// this.push(Buffer.alloc(0))
		const toTransfer = Math.min(this.size - this._transferred, chunkSize)
		if (this.speed) await delay((toTransfer / this.speed) * 1000)
		if (this.timeouts.length && this.timeouts[0].after <= this._transferred) {
			console.log('timeout')
			await delay(this.timeouts[0].time)
			this.timeouts.splice(0, 1)
		}
		if (this.aborted) {
			this.push(null)
			return
		}
		this.push(Buffer.alloc(toTransfer))
		this._transferred += toTransfer

		if (this.size <= this._transferred) {
			console.log('TimeoutStream finish')
			this.push(null)
		}
	}
	_destroy() {
		this.aborted = true
		this.push(null)
	}
}

const server = fastify()
server.route({
	method: 'POST',
	url: '/:any',
	handler: async (req, rep) => {
		const {
			requestTimeout,
			size = 1024 * 1024,
			speed,
			bodyTimeouts = [],
			status,
		} = req.body
		if (status) {
			rep.code(status)
		}

		if (requestTimeout) {
			await delay(requestTimeout)
		}

		console.log('ready to send')

		// return
		return new TimeoutStream(size, speed, requestTimeout, bodyTimeouts)
	},
})

let port

const start = async () => {
	await server.listen(50000)
	port = server.server.address().port

	console.log('request start')
	const res = await fetch(`http://localhost:${port}/asd`, {
		method: 'POST',
		body: JSON.stringify({
			size: 512 * 1024,
			requestTimeout: 3000,
			speed: 128 * 1024,
			bodyTimeouts: [
				// {time: 3000, after: 0},
				// {time: 1000, after: 256 * 1024},
			],
		}),
		headers: {'content-type': 'application/json'},
	})
	console.log(res.headers)

	if (res?.body) {
		/** @type ReadableStreamDefaultReader<Uint8Array> */
		let reader
		let bytesTransferred
		const measureStream = new ReadableStream({
			type: 'bytes',

			start() {
				console.log('original stream locked')
				reader = res.body.getReader()
			},

			async pull(controller) {
				if (bytesTransferred === undefined) {
					console.log('measure: download start')
					bytesTransferred = 0
				}
				const {done, value} = await reader.read()
				if (done) {
					console.log(`measure: download finish, ${bytesTransferred} bytes`)
					return controller.close()
				}
				process.stdout.write('M')
				bytesTransferred += value.byteLength
				controller.enqueue(value)
			},

			cancel(reason) {
				reader.cancel(reason)
			},
		})

		// const modifiedRes = new Proxy(res, {
		// 	get(target, prop, receiver) {
		// 		if (prop === 'body') {
		// 			return measureStream
		// 		}
		// 		return Reflect.get(target, prop, receiver)
		// 	},
		// })

		const modifiedRes = new Response(measureStream, res)
		const clonedRes = modifiedRes.clone()
		console.log(await clonedRes.arrayBuffer())

		console.log(modifiedRes.headers)
		console.log(modifiedRes.statusText)
		console.log(modifiedRes.status)
		console.log(await modifiedRes.arrayBuffer())

		// console.log('actual download: start')
		// for await (const chunk of measureStream) {
		// 	process.stdout.write('D')
		// }
		// console.log('actual download: finish')
	}

	// const transformed = res.body?.pipeThrough(
	// 	new TransformStream({
	// 		transform(chunk, controller) {
	// 			console.log(`Processed ${chunk.byteLength} bytes`)
	// 			controller.enqueue(chunk)
	// 		},

	// 		flush(controller) {
	// 			console.log('flushed')
	// 		},
	// 	})
	// )

	// const [measurable, downloadable] = res.body?.tee()

	// setTimeout(async () => {
	// 	console.log('Measure start')
	// 	for await (const chunk of res.body) {
	// 		process.stdout.write('M')
	// 		// console.log(`Measurable ${chunk.byteLength}`)
	// 	}
	// 	console.log('Measure finish')
	// }, 0)
	// setTimeout(async () => {
	// 	console.log('Download start')
	// 	for await (const chunk of downloadable) {
	// 		process.stdout.write('D')
	// 		// console.log(`Downloadable ${chunk.byteLength}`)
	// 	}
	// 	console.log('Download finish')
	// }, 60000)

	console.log(port)
	await server.close()
}

start()
