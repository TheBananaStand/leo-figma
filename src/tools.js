/**
 * The three tools this server exposes.
 *
 * Everything here is read-only. Figma's REST API can create comments and (on
 * Enterprise) write variables; neither is exposed, so installing this package
 * cannot change anything in a Figma file.
 *
 * All three summarise rather than relay. A `GET /v1/files/:key` on a real
 * design is megabytes of geometry, and handing that to a model spends the
 * context that was supposed to answer the question.
 */

import { FigmaError, fileKey, get, nodeIds } from "./figma.js";

/** Hex from Figma's 0..1 RGBA. Alpha is only appended when it isn't opaque. */
function hex(color, opacity = 1) {
  if (!color) return null;
  const ch = (v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, "0");
  const a = (color.a ?? 1) * (opacity ?? 1);
  return `#${ch(color.r)}${ch(color.g)}${ch(color.b)}${a < 0.999 ? ch(a) : ""}`;
}

/** The first solid paint's hex, which is what "the colour of this" means. */
function paintHex(paints) {
  const solid = (paints ?? []).find((p) => p.type === "SOLID" && p.visible !== false);
  return solid ? hex(solid.color, solid.opacity) : null;
}

function outline(node, depth, atDepth = 0) {
  if (!node) return null;
  const out = { id: node.id, name: node.name, type: node.type };

  const fill = paintHex(node.fills);
  if (fill) out.fill = fill;
  if (node.characters) {
    out.text = node.characters.length > 120 ? `${node.characters.slice(0, 120)}…` : node.characters;
  }
  if (node.absoluteBoundingBox) {
    const { width, height } = node.absoluteBoundingBox;
    if (width && height) out.size = `${Math.round(width)}×${Math.round(height)}`;
  }

  const kids = node.children ?? [];
  if (kids.length && atDepth < depth) {
    out.children = kids.map((k) => outline(k, depth, atDepth + 1));
  } else if (kids.length) {
    // Saying how much was withheld is what makes `depth` usable — otherwise a
    // truncated tree and a complete one read identically.
    out.children_omitted = kids.length;
  }
  return out;
}

export const TOOLS = [
  {
    name: "figma_file",
    description:
      "Read the structure of a Figma file: its pages, frames, components and text. " +
      "Accepts a Figma URL or a bare file key. Returns an outline with node ids — " +
      "pass those to figma_export to render an image, or back to this tool to go deeper.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Figma file URL or file key.",
        },
        node_ids: {
          type: "string",
          description:
            "Optional comma-separated node ids to inspect instead of the whole file. " +
            "Ids from a Figma URL (`1-23`) are accepted and converted.",
        },
        depth: {
          type: "integer",
          description: "How many levels of children to include. Default 2, max 6.",
          default: 2,
        },
      },
      required: ["file"],
    },
    async run(token, args) {
      const key = fileKey(args.file);
      const depth = Math.max(1, Math.min(6, Number(args.depth) || 2));
      const ids = nodeIds(args.node_ids);

      if (ids.length) {
        const body = await get(token, `/v1/files/${key}/nodes`, {
          ids: ids.join(","),
          depth,
        });
        const found = Object.entries(body.nodes ?? {})
          .filter(([, v]) => v?.document)
          .map(([id, v]) => ({ requested_id: id, ...outline(v.document, depth) }));

        if (!found.length) {
          throw new FigmaError(`No nodes matched ${ids.join(", ")} in file ${key}.`, {
            hint: "Node ids come from figma_file, or from `node-id` in a Figma URL.",
          });
        }
        return { file_key: key, nodes: found };
      }

      const body = await get(token, `/v1/files/${key}`, { depth });
      return {
        file_key: key,
        name: body.name,
        last_modified: body.lastModified,
        editor_type: body.editorType,
        pages: (body.document?.children ?? []).map((page) => outline(page, depth)),
      };
    },
  },

  {
    name: "figma_export",
    description:
      "Render Figma frames or components to images and return download URLs. " +
      "Use figma_file first to find node ids. Formats: png, jpg, svg, pdf.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        node_ids: {
          type: "string",
          description: "Comma-separated node ids to render. Ids like `1-23` are accepted.",
        },
        format: {
          type: "string",
          enum: ["png", "jpg", "svg", "pdf"],
          description: "Output format. Default png.",
          default: "png",
        },
        scale: {
          type: "number",
          description: "Raster scale 0.01–4, for png/jpg only. Default 2.",
          default: 2,
        },
      },
      required: ["file", "node_ids"],
    },
    async run(token, args) {
      const key = fileKey(args.file);
      const ids = nodeIds(args.node_ids);
      if (!ids.length) {
        throw new FigmaError("node_ids is required — nothing to render.", {
          hint: "Call figma_file first to list the frames in the file.",
        });
      }

      const format = String(args.format ?? "png").toLowerCase();
      if (!["png", "jpg", "svg", "pdf"].includes(format)) {
        throw new FigmaError(`Unsupported format ${JSON.stringify(args.format)}.`, {
          hint: "Use one of: png, jpg, svg, pdf.",
        });
      }

      const body = await get(token, `/v1/images/${key}`, {
        ids: ids.join(","),
        format,
        // Figma rejects `scale` for the vector formats rather than ignoring it.
        scale: format === "svg" || format === "pdf"
          ? undefined
          : Math.max(0.01, Math.min(4, Number(args.scale) || 2)),
      });

      // Figma reports a node it could not render as a null url with a 200, so
      // an unrendered frame has to be read out of the map rather than caught.
      const images = body.images ?? {};
      const rendered = Object.entries(images).filter(([, url]) => url);
      const failed = Object.entries(images).filter(([, url]) => !url).map(([id]) => id);

      if (!rendered.length) {
        throw new FigmaError(`Figma rendered none of: ${ids.join(", ")}.`, {
          hint: body.err ? String(body.err) : "Check the node ids exist in this file.",
        });
      }

      return {
        file_key: key,
        format,
        // Figma's URLs are short-lived S3 links, so a stale one read later is a
        // confusing 403 unless it was labelled at the time it was handed over.
        note: "URLs expire roughly 30 days after generation — download rather than store the link.",
        images: rendered.map(([id, url]) => ({ node_id: id, url })),
        ...(failed.length ? { failed_node_ids: failed } : {}),
      };
    },
  },

  {
    name: "figma_tokens",
    description:
      "Extract design tokens (colours, typography, spacing) from a Figma file. " +
      "Uses Figma Variables when the account is on an Enterprise plan, and otherwise " +
      "derives tokens from the file's published styles.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
      },
      required: ["file"],
    },
    async run(token, args) {
      const key = fileKey(args.file);

      // Variables are the real answer, and are Enterprise-only. Falling back on
      // a 403 rather than requiring the caller to know their own plan is the
      // difference between a tool that works for everyone and one that works
      // for a minority and errors for the rest.
      try {
        return { file_key: key, source: "variables", ...(await variables(token, key)) };
      } catch (e) {
        if (!(e instanceof FigmaError) || (e.status !== 403 && e.status !== 404)) throw e;
        return {
          file_key: key,
          source: "styles",
          note:
            "Figma's Variables API needs an Enterprise plan, so these tokens were derived " +
            "from the file's styles instead.",
          ...(await styleTokens(token, key)),
        };
      }
    },
  },
];

/** Tokens from the Variables API. `GET /v1/files/:key/variables/local`. */
async function variables(token, key) {
  const body = await get(token, `/v1/files/${key}/variables/local`);
  const collections = body.meta?.variableCollections ?? {};
  const vars = Object.values(body.meta?.variables ?? {});

  const modeName = (collectionId, modeId) =>
    (collections[collectionId]?.modes ?? []).find((m) => m.modeId === modeId)?.name ?? modeId;

  return {
    collections: Object.values(collections).map((c) => ({
      name: c.name,
      modes: (c.modes ?? []).map((m) => m.name),
    })),
    tokens: vars.map((v) => ({
      name: v.name,
      type: v.resolvedType,
      values: Object.entries(v.valuesByMode ?? {}).map(([modeId, value]) => ({
        mode: modeName(v.variableCollectionId, modeId),
        value:
          v.resolvedType === "COLOR" && value && typeof value === "object" && "r" in value
            ? hex(value)
            : // An alias points at another variable rather than holding a value.
              value?.type === "VARIABLE_ALIAS"
              ? `→ ${body.meta?.variables?.[value.id]?.name ?? value.id}`
              : value,
      })),
    })),
  };
}

/**
 * Tokens derived from styles, for the plans without the Variables API.
 *
 * A file's `styles` map names the published styles but holds no values — those
 * live on whichever nodes use each style. So the document is walked once and
 * the first node using each style donates its value.
 */
async function styleTokens(token, key) {
  const body = await get(token, `/v1/files/${key}`, { depth: 6 });
  const styles = body.styles ?? {};
  const found = new Map();

  const walk = (node) => {
    if (!node || found.size >= Object.keys(styles).length) return;
    for (const [kind, styleId] of Object.entries(node.styles ?? {})) {
      if (found.has(styleId)) continue;
      if (kind === "fill" || kind === "fills") {
        const value = paintHex(node.fills);
        if (value) found.set(styleId, { value, kind: "color" });
      } else if (kind === "text" && node.style) {
        const s = node.style;
        found.set(styleId, {
          kind: "typography",
          value: {
            family: s.fontFamily,
            weight: s.fontWeight,
            size: s.fontSize,
            line_height: s.lineHeightPx ? Math.round(s.lineHeightPx) : undefined,
            letter_spacing: s.letterSpacing || undefined,
          },
        });
      } else if (kind === "stroke" || kind === "strokes") {
        const value = paintHex(node.strokes);
        if (value) found.set(styleId, { value, kind: "border" });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(body.document);

  const tokens = Object.entries(styles).map(([id, meta]) => ({
    name: meta.name,
    type: (meta.styleType ?? "").toLowerCase(),
    ...(found.get(id) ?? {
      // Naming what wasn't resolved keeps the gap visible: a style defined in a
      // library but unused in this file has no value to read here.
      unresolved: "defined but not used in this file, so it carries no value here",
    }),
  }));

  return { token_count: tokens.length, tokens };
}
