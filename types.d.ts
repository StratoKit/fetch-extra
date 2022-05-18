declare module 'node-fetch-wrapper'

type Resource = import('undici/types/fetch').RequestInfo
type FetchResponse = import('undici/types/fetch').Response & {
	completed: Promise<FetchStats>
}
type RetryResponse =
	| {
			resource?: Resource
			options?: FetchOptions
	  }
	| boolean
type RetryDef =
	| number
	| ((params: RetryFnParams) => Promise<RetryResponse> | RetryResponse)
type FetchState = {
	resource: Resource
	options: FetchOptions
	userSignal?: AbortSignal
	retry?: RetryDef
	fetchId: number | string
	attempt: number
	completed: Promise<FetchStats>
	resolve: (stats: FetchStats) => void
	reject: (error: Error & {stats: FetchStats}) => void
	startTs: number
	bodyTs?: number
	size: number
}
type FetchStats = {
	size: number
	duration: number
	attempts: number
	speed: number
}
type RetryFnParams = {
	state: FetchState
	error?: Error
	response?: FetchResponse
}
type ValidateFn = (data: any, state: FetchState) => Promise<void> | void
type FetchOptions = import('undici/types/fetch').RequestInit & {
	retry?: RetryDef
	timeout?: number
	timeouts?: {
		overall?: number
		request?: number
		stall?: number
		body?: number
	}
	validate?:
		| true
		| ValidateFn
		| {
				response?: boolean | ValidateFn
				buffer?: ValidateFn
				blob?: ValidateFn
				arrayBuffer?: ValidateFn
				json?: ValidateFn
				text?: ValidateFn
				textConverted?: ValidateFn
		  }
	signal?: AbortSignal
	limiter?: ReturnType<import('async-sema').RateLimit>
}
