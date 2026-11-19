import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireBookingRole, type Caller } from '../auth.js';
import { BadRequestError, HandleInvalidError, HandleMismatchError } from '../errors.js';
import type { Address, ErpDocuments } from '../providers/documents.js';
import type { ErpProvider } from '../providers/types.js';
import { buildSeed, type ShipmentLinkRef } from '../seed.js';
import { HANDLE_TTL_MS, hashHandle, newHandle, type HandleStore } from '../store/handles.js';
import { setupUpdateSchema, type CompanySetup, type SettingsStore } from '../store/settings.js';
import type { ProviderId } from '../store/types.js';
import { NotConnectedError, type TokenService } from '../tokens.js';
import { ReconnectRequiredError } from '../providers/types.js';

export interface DocumentRouteDeps {
  providers: Map<ProviderId, ErpProvider>;
  tokens: TokenService;
  handles: HandleStore;
  settings: SettingsStore;
  authenticate: (req: FastifyRequest) => Caller;
  now: () => number;
}

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const EXTRACTABLE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const listQuery = z.object({
  type: z.string().max(32).optional(),
  status: z.enum(['open', 'paid', 'closed', 'all']).default('open'),
  q: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const typeQuery = z.object({ type: z.string().min(1).max(32) });
const versionQuery = typeQuery.extend({ handle: z.string().max(200).optional() });

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BadRequestError('Invalid request', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/** Shipment links per document come with the link store (group 2); until then every document has none. */
const noLinks = async (): Promise<ShipmentLinkRef[]> => [];

export function registerDocumentRoutes(app: FastifyInstance, deps: DocumentRouteDeps): void {
  const { providers, tokens, handles, settings, authenticate, now } = deps;
  const docsCache = new Map<ProviderId, ErpDocuments>();
  const originCache = new Map<string, { address: Address | undefined; exp: number }>();

  function resolve(req: FastifyRequest) {
    const caller = authenticate(req);
    const provider = providers.get((req.params as { provider: string }).provider as ProviderId);
    if (!provider) return { caller, provider: undefined, docs: undefined };
    let docs = docsCache.get(provider.id);
    if (!docs) {
      docs = provider.documents((companyId, fn) => tokens.withAccess(provider.id, companyId, fn));
      docsCache.set(provider.id, docs);
    }
    return { caller, provider, docs };
  }

  const checkType = (provider: ErpProvider, type: string) => {
    if (!provider.capabilities.documentTypes.includes(type)) {
      throw new BadRequestError('Unsupported document type', [{ field: 'type', message: `must be one of ${provider.capabilities.documentTypes.join(', ')}` }]);
    }
  };
  const checkId = (id: string) => {
    if (!ID_RE.test(id)) throw new BadRequestError('Invalid document id', [{ field: 'id', message: 'invalid' }]);
  };

  /** The ERP company address, cached briefly; only used to prefill the pickup address. */
  async function companyAddress(provider: ErpProvider, docs: ErpDocuments, companyId: string): Promise<Address | undefined> {
    const key = `${provider.id}:${companyId}`;
    const hit = originCache.get(key);
    if (hit && hit.exp > now()) return hit.address;
    try {
      const address = await docs.companyAddress(companyId);
      originCache.set(key, { address, exp: now() + 10 * 60 * 1000 });
      return address;
    } catch (err) {
      if (err instanceof NotConnectedError || err instanceof ReconnectRequiredError) throw err;
      return undefined; // best effort: a prefill must never block the seed
    }
  }

  // ---- list ---------------------------------------------------------------------------------
  app.get('/v1/:provider/documents', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    const q = parse(listQuery, req.query);
    if (q.type) checkType(provider, q.type);

    const page = await docs.list(caller.companyId, q);
    const items = await Promise.all(
      page.items.map(async (d) => {
        const shipmentLinks = await noLinks();
        return { ...d, linkedDocuments: d.linkedDocuments.length ? d.linkedDocuments : undefined, shipmentLinks, shipmentCount: shipmentLinks.length };
      }),
    );
    return { items, nextCursor: page.nextCursor };
  });

  // ---- one document = the seed -----------------------------------------------------------------
  app.get('/v1/:provider/documents/:id', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    const { id } = req.params as { id: string };
    const { type } = parse(typeQuery, req.query);
    checkType(provider, type);
    checkId(id);

    const doc = await docs.get(caller.companyId, type, id);
    const [attachments, setup] = await Promise.all([
      docs.attachments(caller.companyId, type, id).catch(() => []), // a missing attachment list must never block the seed
      settings.get(provider.id, caller.companyId),
    ]);

    const origin = setup.defaultOrigin
      ? { address: setup.defaultOrigin, origin: 'default' as const }
      : { address: await companyAddress(provider, docs, caller.companyId), origin: 'erp' as const };

    const handle = newHandle();
    const createdAt = now();
    await handles.put({
      hash: hashHandle(handle),
      companyId: caller.companyId,
      userId: caller.userId,
      provider: provider.id,
      realmId: doc.realmId,
      docType: doc.type,
      docId: doc.id,
      docNumber: doc.number,
      version: doc.version,
      createdAt,
      expiresAt: createdAt + HANDLE_TTL_MS,
    });

    return buildSeed({
      provider: provider.id,
      doc,
      attachments,
      origin,
      handle,
      shipmentLinks: await noLinks(),
    });
  });

  // ---- version check, just before booking ---------------------------------------------------------
  app.get('/v1/:provider/documents/:id/version', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    const { id } = req.params as { id: string };
    const { type, handle } = parse(versionQuery, req.query);
    checkType(provider, type);
    checkId(id);

    let seededVersion: string | undefined;
    if (handle) {
      const rec = await handles.get(hashHandle(handle));
      if (!rec || rec.companyId !== caller.companyId || rec.userId !== caller.userId) throw new HandleInvalidError();
      if (rec.provider !== provider.id || rec.docType !== type || rec.docId !== id) throw new HandleMismatchError();
      seededVersion = rec.version;
    }

    const doc = await docs.get(caller.companyId, type, id);
    return {
      version: doc.version,
      status: doc.status,
      changed: seededVersion === undefined ? false : seededVersion !== doc.version,
      closed: doc.status === 'closed',
      linkedDocuments: doc.linkedDocuments.length ? doc.linkedDocuments : undefined,
    };
  });

  // ---- attachments ---------------------------------------------------------------------------------
  app.get('/v1/:provider/documents/:id/attachments', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    const { id } = req.params as { id: string };
    const { type } = parse(typeQuery, req.query);
    checkType(provider, type);
    checkId(id);
    return docs.attachments(caller.companyId, type, id);
  });

  app.get('/v1/:provider/documents/:id/attachments/:attId', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    const { id, attId } = req.params as { id: string; attId: string };
    const { type } = parse(typeQuery, req.query);
    checkType(provider, type);
    checkId(id);
    checkId(attId);

    const file = await docs.attachment(caller.companyId, type, id, attId);
    const safeName = encodeURIComponent(file.name).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    // The web app only reads PDF, JPEG and PNG. Those keep their type; anything else is served as an opaque
    // download (the original type is in x-original-content-type), so no binary file is ever mangled as text.
    const keepsType = EXTRACTABLE_TYPES.has(file.contentType.split(';')[0]!.trim().toLowerCase());
    return reply
      .header('content-type', keepsType ? file.contentType : 'application/octet-stream')
      .header('x-original-content-type', file.contentType)
      .header('content-disposition', `attachment; filename*=UTF-8''${safeName}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(file.data);
  });

  // ---- setup (self-describing) --------------------------------------------------------------------
  async function setupResponse(provider: ErpProvider, docs: ErpDocuments, companyId: string) {
    const setup = await settings.get(provider.id, companyId);
    let prefill: Address | undefined;
    if (!setup.defaultOrigin) {
      try {
        prefill = await companyAddress(provider, docs, companyId);
      } catch {
        prefill = undefined; // not connected yet: the setup page still works without a prefill
      }
    }
    return {
      fields: [
        { key: 'defaultOrigin', label: 'Default pickup address', type: 'address', required: false },
        {
          key: 'writeLinkToMemo',
          label: 'Add the BiziShip shipment link to the QuickBooks document',
          type: 'boolean',
          required: true,
          help: 'Adds one line to the document\'s "Memo on statement", which can appear on customer statements.',
        },
      ],
      values: { defaultOrigin: setup.defaultOrigin ?? prefill ?? null, writeLinkToMemo: setup.writeLinkToMemo },
    };
  }

  app.get('/v1/:provider/setup', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    return setupResponse(provider, docs, caller.companyId);
  });

  app.put('/v1/:provider/setup', async (req, reply) => {
    const { caller, provider, docs } = resolve(req);
    if (!provider || !docs) return reply.code(404).send({ error: 'unknown_provider' });
    requireBookingRole(caller);
    const { values } = parse(setupUpdateSchema, req.body ?? {});
    req.log.info(
      { audit: 'setup_changed', provider: provider.id, companyId: caller.companyId, userId: caller.userId, fields: Object.keys(values) },
      'Audit: setup changed',
    );

    const current = await settings.get(provider.id, caller.companyId);
    const next: CompanySetup = { ...current };
    if (values.writeLinkToMemo !== undefined) next.writeLinkToMemo = values.writeLinkToMemo;
    if (values.defaultOrigin !== undefined) {
      if (values.defaultOrigin === null) delete next.defaultOrigin;
      else next.defaultOrigin = Object.fromEntries(Object.entries(values.defaultOrigin).filter(([, v]) => v !== undefined && v !== '')) as Address;
    }
    await settings.put(provider.id, caller.companyId, next);
    return setupResponse(provider, docs, caller.companyId);
  });
}
