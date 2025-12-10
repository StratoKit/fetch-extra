import {Sema, RateLimit} from 'async-sema'
import {fetch} from './fetch.js'

export const makeFetch = (maxParallel, maxRps) => {
	if (!(maxParallel || maxRps)) return fetch

	const sema = maxParallel && new Sema(maxParallel)
	const limiter = maxRps && RateLimit(maxRps, {uniformDistribution: true})

	return async (resource, options) => {
		if (sema) await sema.acquire()
		const res = await fetch(resource, {
			...options,
			limiter,
		})
		if (sema) res.completed.finally(() => sema.release())
		return res
	}
}
