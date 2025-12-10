declare module 'fetch-extra'

export type Resource = RequestInfo
export type FetchResponse = Response & {
	completed: Promise<FetchStats>
}
export type RetryResponse =
	| {
			resource?: Resource
			options?: FetchOptions
	  }
	| boolean
export type RetryDef =
	| number
	| ((params: RetryFnParams) => Promise<RetryResponse> | RetryResponse)
export declare class FetchState {
	id: number | string
	resource: Resource
	options: FetchOptions
	userSignal?: AbortSignal
	retry?: RetryDef
	attempt: number
	completed: Promise<FetchStats>
	startTs?: number
	bodyTs?: number
	size?: number
}
export type FetchStats = {
	size: number
	duration: number
	attempts: number
	speed: number
}
export type RetryFnParams = {
	state: FetchState
	error?: Error
	response?: FetchResponse
}
export type ValidateFn = (data: any, state: FetchState) => Promise<void> | void
export type FetchOptions = RequestInit & {
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
	// import doesn't work
	// limiter?: ReturnType<import('async-sema').RateLimit>
	limiter?: () => Promise<void>
}
