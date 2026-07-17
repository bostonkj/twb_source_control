/**
 * Express API server wrapping the TWB toolchain. Run: node server.ts
 *
 * POST /api/extract   field: twb          → config JSON download
 * POST /api/patch     fields: config, twb → patched .twb download
 * POST /api/strip     field: twb          → stripped .twb download
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { readXml, writeXml } from './dist/src/xml.js';
import { extractConfig } from './dist/src/extract-config.js';
import { stripAndSanitize } from './dist/src/strip-data.js';
import { patchWorkbook } from './dist/src/patch-twb.js';

// ─── Server setup ─────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT ?? 3000;

// Store uploads in OS temp dir; we'll clean up after each request.
const upload = multer({ dest: os.tmpdir() });

// Serve the frontend from the same directory as this file.
const staticDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
app.use(express.static(staticDir));

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Creates a unique temp directory and returns a cleanup function. */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `twb-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Removes multer's uploaded temp files. */
function cleanupUploads(files: Express.Multer.File[]): void {
  for (const f of files) {
    fs.rmSync(f.path, { force: true });
  }
}

// ─── POST /api/extract ────────────────────────────────────────────────────────

app.post(
  '/api/extract',
  upload.single('twb'),
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) {
      res.status(400).json({ error: 'Missing field: twb' });
      return;
    }

    const { dir, cleanup } = makeTempDir();
    const uploads = [req.file];

    try {
      const inputPath = req.file.path;
      const outputPath = path.join(dir, 'config.json');

      const doc = readXml(inputPath);
      const config = extractConfig(doc);
      fs.writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf8');

      const baseName = path.basename(req.file.originalname, '.twb');
      res.download(outputPath, `${baseName}_config.json`, () => {
        cleanup();
        cleanupUploads(uploads);
      });
    } catch (err) {
      cleanup();
      cleanupUploads(uploads);
      next(err);
    }
  }
);

// ─── POST /api/patch ──────────────────────────────────────────────────────────

app.post(
  '/api/patch',
  upload.fields([
    { name: 'config', maxCount: 1 },
    { name: 'twb', maxCount: 1 },
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const configFile = files?.['config']?.[0];
    const twbFile = files?.['twb']?.[0];

    if (!configFile || !twbFile) {
      res.status(400).json({ error: 'Missing fields: config and twb are both required' });
      return;
    }

    const { dir, cleanup } = makeTempDir();
    const uploads = [configFile, twbFile];

    try {
      const configPath = configFile.path;
      const templatePath = twbFile.path;
      const outputPath = path.join(dir, 'patched.twb');

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const doc = readXml(templatePath);
      patchWorkbook(doc, config);
      writeXml(outputPath, doc);

      const baseName = path.basename(twbFile.originalname, '.twb');
      res.download(outputPath, `${baseName}_patched.twb`, () => {
        cleanup();
        cleanupUploads(uploads);
      });
    } catch (err) {
      cleanup();
      cleanupUploads(uploads);
      next(err);
    }
  }
);

// ─── POST /api/strip ──────────────────────────────────────────────────────────

app.post(
  '/api/strip',
  upload.single('twb'),
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) {
      res.status(400).json({ error: 'Missing field: twb' });
      return;
    }

    const { dir, cleanup } = makeTempDir();
    const uploads = [req.file];

    try {
      const inputPath = req.file.path;
      const outputPath = path.join(dir, 'stripped.twb');

      const doc = readXml(inputPath);
      stripAndSanitize(doc);
      writeXml(outputPath, doc);

      const baseName = path.basename(req.file.originalname, '.twb');
      res.download(outputPath, `${baseName}_stripped.twb`, () => {
        cleanup();
        cleanupUploads(uploads);
      });
    } catch (err) {
      cleanup();
      cleanupUploads(uploads);
      next(err);
    }
  }
);

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`TWB toolchain server running at http://localhost:${PORT}`);
});
