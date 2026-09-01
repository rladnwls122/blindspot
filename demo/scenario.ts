/**
 * A synthetic but realistic AI-assisted session.
 *
 * An agent was asked to add refresh-token rotation and a per-customer orders
 * table. It wrote 182 lines across five files. The developer read some of it
 * properly, skimmed the parts that "looked fine", and never opened the rest.
 * That is the situation Blindspot exists to describe.
 */

export type ReadingMode =
  /** Written by the agent; the human never looked at it. */
  | 'generate'
  /** Scrolled past at speed. */
  | 'skim'
  /** On screen, focused, but the viewport never stopped. */
  | 'glance'
  /** Read properly, but never clicked into. */
  | 'study'
  /** Read: on screen, focused, paused, navigated to. */
  | 'read'
  /** Typed by the human. */
  | 'write';

export interface Action {
  mode: ReadingMode;
  /** 1-based, inclusive. */
  from: number;
  to: number;
}

export interface ScenarioFile {
  path: string;
  lines: string[];
  actions: Action[];
  /** Lines the agent produced, as one bulk insertion. */
  generated?: [number, number];
}

function repeat(n: number, make: (i: number) => string): string[] {
  return Array.from({ length: n }, (_, i) => make(i + 1));
}

const authLines: string[] = [
  'import { createHmac, timingSafeEqual } from "node:crypto";',
  'import { db } from "../db";',
  '',
  'const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 30;',
  'const SIGNING_KEY = process.env.SESSION_SIGNING_KEY ?? "";',
  '',
  'export interface Session {',
  '  id: string;',
  '  userId: string;',
  '  refreshToken: string;',
  '  expiresAt: number;',
  '}',
  'function sign(payload: string): string {',
  '  return createHmac("sha256", SIGNING_KEY).update(payload).digest("hex");',
  '}',
  'export function verifyRefreshToken(token: string, expected: string): boolean {',
  '  const a = Buffer.from(sign(token));',
  '  const b = Buffer.from(expected);',
  '  if (a.length !== b.length) return false;',
  '  return timingSafeEqual(a, b);',
  '}',
  'export async function rotateSession(oldToken: string): Promise<Session | null> {',
  '  const existing = await db.sessions.findByRefreshToken(oldToken);',
  '  if (!existing) return null;',
  '  if (existing.expiresAt < Date.now()) return null;',
  '',
  '  const nextToken = sign(`${existing.userId}:${Date.now()}`);',
  '  await db.sessions.revoke(existing.id);',
  '  return db.sessions.create({',
  '    userId: existing.userId,',
  '    refreshToken: nextToken,',
  '    expiresAt: Date.now() + REFRESH_TTL_MS,',
  '  });',
  '}',
];

const ordersLines: string[] = [
  'import { Router } from "express";',
  'import { requireSession } from "../auth/session";',
  'import { db } from "../db";',
  '',
  'export const orders = Router();',
  '',
  'orders.get("/orders", requireSession, async (req, res) => {',
  '  const customerId = req.query.customerId as string;',
  '  const page = Number(req.query.page ?? 0);',
  '  const size = Math.min(Number(req.query.size ?? 25), 100);',
  '',
  '  const rows = await db.orders.list({',
  '    customerId,',
  '    offset: page * size,',
  '    limit: size,',
  '  });',
  '',
  '  res.json({ rows, page, size });',
  '});',
  ...repeat(20, (i) => `orders.get("/orders/detail/${i}", requireSession, detailHandler(${i}));`),
  'function detailHandler(kind: number) {',
  '  return async (req: any, res: any) => {',
  '    const order = await db.orders.byId(req.params.id);',
  '    if (!order) return res.status(404).json({ error: "not found" });',
  '    if (order.customerId !== req.session.userId) {',
  '      return res.status(403).json({ error: "forbidden" });',
  '    }',
  '    res.json({ order, kind });',
  '  };',
  '}',
  '',
  ...repeat(10, (i) => `// TODO(agent): pagination cursor for endpoint ${i}`),
];

const tableLines: string[] = [
  'import { useMemo, useState } from "react";',
  'import type { Order } from "../types";',
  '',
  'interface Props {',
  '  orders: Order[];',
  '  onSelect(order: Order): void;',
  '}',
  '',
  'export function OrderTable({ orders, onSelect }: Props) {',
  '  const [sort, setSort] = useState<"date" | "total">("date");',
  '',
  '  const sorted = useMemo(() => {',
  '    return [...orders].sort((a, b) =>',
  '      sort === "date" ? b.createdAt - a.createdAt : b.total - a.total,',
  '    );',
  '  }, [orders, sort]);',
  '',
  '  return (',
  '    <table className="orders">',
  '      <thead>',
  '        <tr>',
  '          <th onClick={() => setSort("date")}>Date</th>',
  '          <th onClick={() => setSort("total")}>Total</th>',
  '          <th>Status</th>',
  '        </tr>',
  '      </thead>',
  '      <tbody>',
  '        {sorted.map((order) => (',
  '          <tr key={order.id} onClick={() => onSelect(order)}>',
  '            <td>{new Date(order.createdAt).toLocaleDateString()}</td>',
  '            <td>{order.total.toFixed(2)}</td>',
  '            <td>{order.status}</td>',
  '          </tr>',
  '        ))}',
  '      </tbody>',
  '    </table>',
  '  );',
  '}',
  ...repeat(10, (i) => `// variant ${i}`),
];

const readmeLines: string[] = [
  '## Sessions',
  '',
  'Refresh tokens now rotate on every use. The previous token is revoked',
  'immediately, so a stolen token is usable at most once.',
  '',
  ...repeat(23, (i) => `- note ${i} about the new orders endpoints`),
];

const formatLines: string[] = [
  'export function currency(value: number, locale = "en-US"): string {',
  '  return new Intl.NumberFormat(locale, {',
  '    style: "currency",',
  '    currency: "USD",',
  '  }).format(value);',
  '}',
  '',
  'export function shortDate(ts: number): string {',
  '  return new Date(ts).toISOString().slice(0, 10);',
  '}',
  '',
  'export const noop = () => {};',
];

/**
 * Reading plan. The numbers land where they do because of the scoring model,
 * not because they were written down here: change `reviewThresholdPoints` and
 * these same actions produce a different report.
 */
export const SCENARIO: ScenarioFile[] = [
  {
    // 34 lines of security-critical code, agent-written, barely looked at.
    // The imports and the interface got read; the token rotation did not.
    path: 'src/auth/session.ts',
    lines: authLines,
    generated: [1, authLines.length],
    actions: [
      { mode: 'read', from: 1, to: 8 },
      { mode: 'skim', from: 9, to: 34 },
    ],
  },
  {
    // 60 lines of API code: the handler was reviewed, the 20 generated
    // endpoint registrations in the middle were scrolled past.
    path: 'src/api/orders.ts',
    lines: ordersLines,
    generated: [19, 60],
    actions: [
      { mode: 'read', from: 1, to: 18 },
      { mode: 'write', from: 8, to: 10 },
      { mode: 'glance', from: 19, to: 38 },
      { mode: 'study', from: 39, to: 50 },
      { mode: 'read', from: 51, to: 60 },
    ],
  },
  {
    // 48 lines of UI the developer actually worked on.
    path: 'src/components/OrderTable.tsx',
    lines: tableLines,
    generated: [1, 20],
    actions: [
      { mode: 'read', from: 1, to: 44 },
      { mode: 'write', from: 10, to: 16 },
      { mode: 'skim', from: 45, to: 48 },
    ],
  },
  {
    // 28 lines of docs, mostly unread — and that is fine. This is the case
    // the risk model exists for: a big blindspot that does not matter much.
    path: 'README.md',
    lines: readmeLines,
    generated: [5, 28],
    actions: [
      { mode: 'read', from: 1, to: 12 },
      { mode: 'generate', from: 13, to: 28 },
    ],
  },
  {
    // 12 lines the developer wrote by hand, so they are read by definition.
    path: 'src/utils/format.ts',
    lines: formatLines,
    actions: [{ mode: 'write', from: 1, to: 12 }],
  },
];
