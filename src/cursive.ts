import type { ChatCompletionRequestMessage, CreateChatCompletionRequest, CreateChatCompletionResponse } from 'openai-edge'
import { resguard } from 'resguard'
import type { Hookable } from 'hookable'
import { createDebugger, createHooks } from 'hookable'
import { ofetch } from 'ofetch'
import type { FetchInstance } from 'openai-edge/types/base'
import type { CreateEmbeddingRequest } from 'openai-edge-fns'
import { encode } from 'gpt-tokenizer'
import type { CursiveAnswerResult, CursiveAskCost, CursiveAskOnToken, CursiveAskOptions, CursiveAskOptionsWithPrompt, CursiveAskUsage, CursiveHook, CursiveHooks, CursiveSetupOptions } from './types'
import { CursiveError, CursiveErrorCode } from './types'
import { getStream } from './stream'
import { getTokenCountFromFunctions, getUsage } from './usage'
import type { IfNull } from './util'
import { sleep, toSnake } from './util'
import { resolveOpenAIPricing } from './pricing'

export class Cursive {
    public _hooks: Hookable<CursiveHooks>
    public _vendor: {
        openai: ReturnType<typeof createOpenAIClient>
    }

    private _debugger: { close: () => void }
    public options: CursiveSetupOptions

    constructor(options: CursiveSetupOptions) {
        this._hooks = createHooks<CursiveHooks>()
        this._vendor = {
            openai: createOpenAIClient({ apiKey: options.openAI.apiKey }),
        }
        this.options = options

        if (options.debug)
            this._debugger = createDebugger(this._hooks, { tag: 'cursive' })
    }

    on<H extends CursiveHook>(event: H, callback: CursiveHooks[H]) {
        this._hooks.hook(event, callback as any)
    }

    async ask(
        options: CursiveAskOptions,
    ): Promise<CursiveAnswerResult> {
        const result = await buildAnswer(options, this)

        if (result.error) {
            return new CursiveAnswer<CursiveError>({
                result: null,
                error: result.error,
            })
        }

        const newMessages = [
            ...result.messages,
            { role: 'assistant', content: result.answer } as const,
        ]

        return new CursiveAnswer<null>({
            result,
            error: null,
            messages: newMessages,
            cursive: this,
        })
    }

    async embed(content: string) {
        const options = {
            model: 'text-embedding-ada-002',
            input: content,
        }
        await this._hooks.callHook('embedding:before', options)
        const start = Date.now()
        const response = await this._vendor.openai.createEmbedding(options)

        const data = await response.json()

        if (data.error) {
            const error = new CursiveError(data.error.message, data.error, CursiveErrorCode.EmbeddingError)
            await this._hooks.callHook('embedding:error', error, Date.now() - start)
            await this._hooks.callHook('embedding:after', null, error, Date.now() - start)
            throw error
        }
        const result = {
            embedding: data.data[0].embedding,
        }
        await this._hooks.callHook('embedding:success', result, Date.now() - start)
        await this._hooks.callHook('embedding:after', result, null, Date.now() - start)

        return result.embedding as number[]
    }
}

export class CursiveConversation {
    public _cursive: Cursive
    public messages: ChatCompletionRequestMessage[] = []

    constructor(messages: ChatCompletionRequestMessage[]) {
        this.messages = messages
    }

    async ask(options: CursiveAskOptionsWithPrompt): Promise<CursiveAnswerResult> {
        const { prompt, ...rest } = options
        const resolvedOptions = {
            ...(rest as any),
            messages: [
                ...this.messages,
                { role: 'user', content: prompt },
            ],
        }

        const result = await buildAnswer(resolvedOptions, this._cursive)

        if (result.error) {
            return new CursiveAnswer<CursiveError>({
                result: null,
                error: result.error,
            })
        }

        const newMessages = [
            ...result.messages,
            { role: 'assistant', content: result.answer } as const,
        ]

        return new CursiveAnswer<null>({
            result,
            error: null,
            messages: newMessages,
            cursive: this._cursive,
        })
    }
}

export class CursiveAnswer<E extends null | CursiveError> {
    public choices: IfNull<E, string[]>
    public id: IfNull<E, string>
    public model: IfNull<E, string>
    public usage: IfNull<E, CursiveAskUsage>
    public cost: IfNull<E, CursiveAskCost>
    public error: E
    public functionResult?: IfNull<E, any>
    /**
     * The text from the answer of the last choice
     */
    public answer: IfNull<E, string>
    /**
     * A conversation instance with all the messages so far, including this one
     */
    public conversation: IfNull<E, CursiveConversation>

    constructor(options: {
        result: any | null
        error: E
        messages?: ChatCompletionRequestMessage[]
        cursive?: Cursive
    }) {
        if (options.error) {
            this.error = options.error
            this.choices = null
            this.id = null
            this.model = null
            this.usage = null
            this.cost = null
            this.answer = null
            this.conversation = null
            this.functionResult = null
        }
        else {
            this.error = null
            this.choices = options.result.choices
            this.id = options.result.id
            this.model = options.result.model
            this.usage = options.result.usage
            this.cost = options.result.cost
            this.answer = options.result.answer
            this.functionResult = options.result.functionResult
            const conversation = new CursiveConversation(options.messages) as any
            conversation._cursive = options.cursive
            this.conversation = conversation
        }
    }
}

export function useCursive(options: CursiveSetupOptions) {
    return new Cursive(options)
}

function createOpenAIClient(options: { apiKey: string }) {
    const resolvedFetch: FetchInstance = ofetch.native

    async function createChatCompletion(payload: CreateChatCompletionRequest, abortSignal?: AbortSignal) {
        return resolvedFetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: abortSignal,
        })
    }

    async function createEmbedding(payload: CreateEmbeddingRequest, abortSignal?: AbortSignal) {
        return resolvedFetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: abortSignal,
        })
    }

    return { createChatCompletion, createEmbedding }
}

function resolveOptions(options: CursiveAskOptions) {
    const {
        functions: _ = [],
        messages = [],
        model = 'gpt-3.5-turbo-0613',
        systemMessage,
        prompt,
        functionCall,
        abortSignal: __,
        ...rest
    } = options

    const queryMessages = [
        systemMessage && { role: 'system', content: systemMessage },
        ...messages,
        prompt && { role: 'user', content: prompt },
    ].filter(Boolean) as ChatCompletionRequestMessage[]

    const resolvedFunctionCall = functionCall
        ? typeof functionCall === 'string'
            ? functionCall
            : { name: functionCall.schema.name }
        : undefined

    const payload: CreateChatCompletionRequest = {
        ...toSnake(rest),
        model,
        messages: queryMessages,
        function_call: resolvedFunctionCall,
    }

    const resolvedOptions = {
        ...rest,
        model,
        messages: queryMessages,
    }

    return { payload, resolvedOptions }
}

async function createCompletion(context: {
    payload: CreateChatCompletionRequest
    cursive: Cursive
    abortSignal?: AbortSignal
    onToken?: CursiveAskOnToken
}) {
    const { payload, abortSignal } = context
    await context.cursive._hooks.callHook('completion:before', payload)
    const start = Date.now()
    const response = await context.cursive._vendor.openai.createChatCompletion({ ...payload }, abortSignal)
    let data: any

    if (payload.stream) {
        const reader = getStream(response).getReader()
        data = {
            choices: [],
            usage: {
                completion_tokens: 0,
                prompt_tokens: getUsage(payload.messages, payload.model),
            },
            model: payload.model,
        }

        if (payload.functions)
            data.usage.prompt_tokens += getTokenCountFromFunctions(payload.functions)

        while (true) {
            const { done, value } = await reader.read()
            if (done)
                break

            data = {
                ...data,
                id: value.id,
            }
            value.choices.forEach((choice: any, i: number) => {
                const { delta } = choice

                if (!data.choices[i]) {
                    data.choices[i] = {
                        message: {
                            function_call: null,
                            role: 'assistant',
                            content: '',
                        },
                    }
                }

                if (delta?.function_call?.name)
                    data.choices[i].message.function_call = delta.function_call

                if (delta?.function_call?.arguments)
                    data.choices[i].message.function_call.arguments += delta.function_call.arguments

                if (delta?.content)
                    data.choices[i].message.content += delta.content

                if (context.onToken) {
                    let chunk: Record<string, any> | null = null
                    if (delta?.function_call) {
                        chunk = {
                            functionCall: delta.function_call,
                        }
                    }

                    if (delta?.content) {
                        chunk = {
                            content: delta.content,
                        }
                    }

                    if (chunk)
                        context.onToken(chunk as any)
                }
            })
        }
        const content = data.choices[0].message.content
        data.usage.completion_tokens = encode(content).length
        data.usage.total_tokens = data.usage.completion_tokens + data.usage.prompt_tokens
    }
    else {
        data = await response.json()
    }

    const end = Date.now()

    if (data.error) {
        const error = new CursiveError(data.error.message, data.error, CursiveErrorCode.CompletionError)
        await context.cursive._hooks.callHook('completion:error', error, end - start)
        await context.cursive._hooks.callHook('completion:after', null, error, end - start)
        throw error
    }

    data.cost = resolveOpenAIPricing({
        completionTokens: data.usage.completion_tokens,
        promptTokens: data.usage.prompt_tokens,
        totalTokens: data.usage.total_tokens,
    }, data.model)

    await context.cursive._hooks.callHook('completion:success', data, end - start)
    await context.cursive._hooks.callHook('completion:after', data, null, end - start)

    return data as CreateChatCompletionResponse & { cost: CursiveAskCost }
}

async function askModel(
    options: CursiveAskOptions,
    cursive: Cursive,
): Promise<{
        answer: CreateChatCompletionResponse & { functionResult?: any }
        messages: ChatCompletionRequestMessage[]
    }> {
    await cursive._hooks.callHook('query:before', options)

    const { payload, resolvedOptions } = resolveOptions(options)
    const functions = options.functions || []

    if (typeof options.functionCall !== 'string' && options.functionCall?.schema)
        functions.push(options.functionCall)

    const functionSchemas = functions.map(({ schema }) => schema)

    if (functionSchemas.length > 0)
        payload.functions = functionSchemas

    let completion = await resguard(createCompletion({
        payload,
        cursive,
        onToken: options.onToken,
        abortSignal: options.abortSignal,
    }), CursiveError)

    if (completion.error) {
        if (!completion.error?.details)
            throw new CursiveError('Unknown error', completion.error, CursiveErrorCode.UnknownError)

        const cause = completion.error.details.code || completion.error.details.type
        if (cause === 'context_length_exceeded') {
            if (!cursive.options.expand || cursive.options.expand?.enabled === true) {
                const defaultModel = cursive.options?.expand?.defaultsTo || 'gpt-3.5-turbo-16k'
                const modelMapping = cursive.options?.expand?.modelMapping || {}
                const resolvedModel = modelMapping[options.model] || defaultModel
                completion = await resguard(
                    createCompletion({
                        payload: { ...payload, model: resolvedModel },
                        cursive,
                        onToken: options.onToken,
                        abortSignal: options.abortSignal,
                    }),
                    CursiveError,
                )
            }
        }

        else if (cause === 'invalid_request_error') {
            throw new CursiveError('Invalid request', completion.error.details, CursiveErrorCode.InvalidRequestError)
        }

        // TODO: Handle other errors

        if (completion.error) {
            // TODO: Add a more comprehensive retry strategy
            for (let i = 0; i < cursive.options.maxRetries; i++) {
                completion = await resguard(createCompletion({
                    payload,
                    cursive,
                    onToken: options.onToken,
                    abortSignal: options.abortSignal,
                }), CursiveError)

                if (!completion.error) {
                    if (i > 3)
                        await sleep(1000 * (i - 3) * 2)
                    break
                }
            }
        }
    }

    if (completion.error) {
        const error = new CursiveError('Error while completing request', completion.error.details, CursiveErrorCode.CompletionError)
        await cursive._hooks.callHook('query:error', error)
        await cursive._hooks.callHook('query:after', null, error)
        throw error
    }

    if (completion.data?.choices[0].message?.function_call) {
        payload.messages.push({
            role: 'assistant',
            function_call: completion.data.choices[0].message?.function_call,
            content: '',
        })
        const functionCall = completion.data.choices[0].message?.function_call
        const functionDefinition = functions.find(({ schema }) => schema.name === functionCall.name)

        if (!functionDefinition) {
            return await askModel(
                {
                    ...resolvedOptions as any,
                    functionCall: 'none',
                    messages: payload.messages,
                },
                cursive,
            )
        }

        const args = resguard(() => JSON.parse(functionCall.arguments || '{}'), SyntaxError)
        const functionResult = await resguard(functionDefinition.definition(args.data))

        if (functionResult.error) {
            throw new CursiveError(
                `Error while running function ${functionCall.name}`,
                functionResult.error,
                CursiveErrorCode.FunctionCallError,
            )
        }

        const messages = payload.messages || []

        messages.push({
            role: 'function',
            name: functionCall.name,
            content: JSON.stringify(functionResult.data || ''),
        })

        if (functionDefinition.pause) {
            return {
                answer: {
                    ...completion.data,
                    functionResult: functionResult.data,
                },
                messages,
            }
        }
        else {
            return await askModel(
                {
                    ...resolvedOptions as any,
                    functions,
                    messages,
                },
                cursive,
            )
        }
    }

    await cursive._hooks.callHook('query:after', completion.data, null)
    await cursive._hooks.callHook('query:success', completion.data)

    return {
        answer: completion.data,
        messages: payload.messages || [],
    }
}

async function buildAnswer(
    options: CursiveAskOptions,
    cursive: Cursive,
): Promise<CursiveEnrichedAnswer> {
    const result = await resguard(askModel(options, cursive), CursiveError)

    if (result.error) {
        return {
            error: result.error,
            usage: null,
            model: options.model || 'gpt-3.5-turbo',
            id: null,
            choices: null,
            functionResult: null,
            answer: null,
            messages: null,
            cost: null,
        }
    }
    else {
        const usage: CursiveAskUsage = {
            completionTokens: result.data.answer.usage!.completion_tokens,
            promptTokens: result.data.answer.usage!.prompt_tokens,
            totalTokens: result.data.answer.usage!.total_tokens,
        }

        const cost = resolveOpenAIPricing(usage, result.data.answer.model)

        const newMessage = {
            error: null,
            model: result.data.answer.model,
            id: result.data.answer.id,
            usage,
            cost,
            choices: result.data.answer.choices.map(choice => choice.message.content),
            functionResult: result.data.answer.functionResult || null,
            answer: result.data.answer.choices[result.data.answer.choices.length - 1].message.content,
            messages: result.data.messages,
        }

        return newMessage
    }
}

interface CursiveEnrichedAnswer {
    error: CursiveError | null
    usage: CursiveAskUsage
    model: string
    id: string
    choices: string[]
    functionResult: any
    answer: string
    messages: ChatCompletionRequestMessage[]
    cost: CursiveAskCost
}
