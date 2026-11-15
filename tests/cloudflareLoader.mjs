// The OAuth library subclasses this runtime class. Tests exercise its real
// protocol logic in Node with in-memory bindings, not the Cloudflare runtime.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return {
      url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx,env){this.ctx=ctx;this.env=env} }',
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
