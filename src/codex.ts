import {
  lazyStream,
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export function accountProviderId(id: string): string {
  return `pi-accounts-codex-${id}`;
}

// Only this account is native on the wire. Other accounts (including plain
// openai-codex) stay foreign so Pi drops their signatures and normalizes tool IDs.
function wireContext(context: Context, provider: string): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "assistant") return message;
      return {
        ...message,
        provider: message.provider === provider
          ? "openai-codex"
          : message.provider === "openai-codex"
            ? "pi-accounts-foreign-codex"
            : message.provider,
      };
    }),
  };
}

function accountStream(
  model: Model<Api>,
  context: Context,
  options: StreamOptions | undefined,
  run: Provider["streamSimple"],
) {
  return lazyStream(model, async () => {
    const source = run({ ...model, provider: "openai-codex" }, wireContext(context, model.provider), {
      ...options,
      onPayload: options?.onPayload && ((payload) => options.onPayload!(payload, model)),
      onResponse: options?.onResponse && ((response) => options.onResponse!(response, model)),
    });
    return (async function* (): AsyncGenerator<AssistantMessageEvent> {
      for await (const event of source) {
        if (event.type === "done") {
          yield { ...event, message: { ...event.message, provider: model.provider } };
        } else if (event.type === "error") {
          yield { ...event, error: { ...event.error, provider: model.provider } };
        } else {
          yield { ...event, partial: { ...event.partial, provider: model.provider } };
        }
      }
    })();
  });
}

export function createCodexAccountProvider(id: string): Provider {
  const native = builtinProviders().find((provider) => provider.id === "openai-codex");
  if (!native?.auth.oauth) throw new Error("pi-accounts requires Pi's native Codex OAuth provider.");
  const provider = accountProviderId(id);
  return {
    id: provider,
    name: id,
    baseUrl: native.baseUrl,
    // OAuth only: no ambient API key or other account's credential fallback.
    auth: { oauth: native.auth.oauth },
    // ponytail: bundled Codex catalog only; adapt refreshModels before adding dynamic catalogs.
    getModels: () => native.getModels().map((model) => ({ ...model, provider })),
    stream: (model, context, options) => accountStream(model, context, options, native.stream),
    streamSimple: (model, context, options) => accountStream(model, context, options, native.streamSimple),
  };
}
