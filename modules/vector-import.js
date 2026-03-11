// vector-import.js — Parse SVG/DXF files into arrays of paths for knife cutting.
// Supports open and closed paths (lines, polylines, arcs, circles, bezier curves).
// SVG uses browser DOM for accurate path sampling. DXF uses a minimal parser.

/**
 * Parse SVG text into paths.
 * @returns {{ paths: Array<{points, isClosed, id, label}>, bounds }}
 */
export function parseSVGFile(svgText) {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
  container.innerHTML = svgText;
  document.body.appendChild(container);

  const svg = container.querySelector('svg');
  if (!svg) {
    document.body.removeChild(container);
    throw new Error('No SVG element found in file');
  }

  if (!svg.getAttribute('width') && !svg.getAttribute('viewBox')) {
    svg.setAttribute('width', '100');
    svg.setAttribute('height', '100');
  }

  const elements = svg.querySelectorAll('path, polygon, polyline, rect, circle, ellipse, line');
  const rawPaths = [];

  for (const el of elements) {
    try {
      const result = sampleElement(el);
      if (result && result.points.length >= 2) {
        rawPaths.push(result);
      }
    } catch (e) {
      console.warn('Skipping SVG element:', e.message);
    }
  }

  document.body.removeChild(container);

  if (rawPaths.length === 0) {
    throw new Error('No valid paths found in SVG');
  }

  // SVG Y is positive-down; CNC Y is positive-up. Flip.
  let maxY = -Infinity;
  for (const p of rawPaths) {
    for (const pt of p.points) maxY = Math.max(maxY, pt.y);
  }
  for (const p of rawPaths) {
    for (const pt of p.points) pt.y = maxY - pt.y;
  }

  // Normalize so minimum X,Y is at origin
  let minX = Infinity, minY = Infinity;
  for (const p of rawPaths) {
    for (const pt of p.points) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
    }
  }
  for (const p of rawPaths) {
    for (const pt of p.points) {
      pt.x -= minX;
      pt.y -= minY;
    }
  }

  // Build final paths with IDs
  const paths = rawPaths.map((p, i) => ({
    points: p.points,
    isClosed: p.isClosed,
    id: i,
    label: `Path ${i + 1} (${p.isClosed ? 'closed' : 'open'}, ${p.points.length} pts)`,
  }));

  return { paths, bounds: computeBounds(paths) };
}

/**
 * Parse DXF text into paths.
 * @returns {{ paths: Array<{points, isClosed, id, label}>, bounds }}
 */
export function parseDXFFile(dxfText) {
  const lines = dxfText.split(/\r?\n/);
  const entities = parseEntities(lines);

  if (entities.length === 0) {
    throw new Error('No supported entities found in DXF file');
  }

  const rawPaths = [];
  for (const entity of entities) {
    const result = entityToPath(entity);
    if (result && result.points.length >= 2) {
      rawPaths.push(result);
    }
  }

  if (rawPaths.length === 0) {
    throw new Error('No valid paths found in DXF file');
  }

  // Normalize to origin
  let minX = Infinity, minY = Infinity;
  for (const p of rawPaths) {
    for (const pt of p.points) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
    }
  }
  for (const p of rawPaths) {
    for (const pt of p.points) {
      pt.x -= minX;
      pt.y -= minY;
    }
  }

  const paths = rawPaths.map((p, i) => ({
    points: p.points,
    isClosed: p.isClosed,
    id: i,
    label: `Path ${i + 1} (${p.isClosed ? 'closed' : 'open'}, ${p.points.length} pts)`,
  }));

  return { paths, bounds: computeBounds(paths) };
}

// ── SVG sampling helpers ──

function sampleElement(el) {
  if (el.tagName === 'rect') return sampleRect(el);
  if (el.tagName === 'circle') return sampleCircle(el);
  if (el.tagName === 'ellipse') return sampleEllipse(el);
  if (el.tagName === 'line') return sampleLine(el);
  if (el.tagName === 'polygon') return samplePolyElement(el, true);
  if (el.tagName === 'polyline') return samplePolyElement(el, false);

  // <path> — use getTotalLength / getPointAtLength
  if (typeof el.getTotalLength !== 'function') return null;
  const totalLength = el.getTotalLength();
  if (totalLength < 1e-6) return null;

  const numSamples = Math.max(20, Math.min(1000, Math.ceil(totalLength / 0.5)));
  const step = totalLength / numSamples;
  const points = [];
  const ctm = el.getCTM();

  for (let i = 0; i <= numSamples; i++) {
    const pt = el.getPointAtLength(Math.min(i * step, totalLength));
    if (ctm) {
      points.push({
        x: ctm.a * pt.x + ctm.c * pt.y + ctm.e,
        y: ctm.b * pt.x + ctm.d * pt.y + ctm.f,
      });
    } else {
      points.push({ x: pt.x, y: pt.y });
    }
  }

  // Check if closed
  let isClosed = false;
  if (points.length >= 3) {
    const first = points[0], last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-3) {
      points.pop();
      isClosed = true;
    }
  }

  return points.length >= 2 ? { points, isClosed } : null;
}

function applyCtm(ctm, x, y) {
  if (!ctm) return { x, y };
  return { x: ctm.a * x + ctm.c * y + ctm.e, y: ctm.b * x + ctm.d * y + ctm.f };
}

function sampleRect(el) {
  const ctm = el.getCTM();
  const x = parseFloat(el.getAttribute('x') || 0);
  const y = parseFloat(el.getAttribute('y') || 0);
  const w = parseFloat(el.getAttribute('width'));
  const h = parseFloat(el.getAttribute('height'));
  if (!w || !h) return null;
  const points = [
    applyCtm(ctm, x, y), applyCtm(ctm, x + w, y),
    applyCtm(ctm, x + w, y + h), applyCtm(ctm, x, y + h),
  ];
  return { points, isClosed: true };
}

function sampleCircle(el) {
  const ctm = el.getCTM();
  const cx = parseFloat(el.getAttribute('cx') || 0);
  const cy = parseFloat(el.getAttribute('cy') || 0);
  const r = parseFloat(el.getAttribute('r'));
  if (!r) return null;
  const n = 180;
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push(applyCtm(ctm, cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return { points, isClosed: true };
}

function sampleEllipse(el) {
  const ctm = el.getCTM();
  const cx = parseFloat(el.getAttribute('cx') || 0);
  const cy = parseFloat(el.getAttribute('cy') || 0);
  const rx = parseFloat(el.getAttribute('rx'));
  const ry = parseFloat(el.getAttribute('ry'));
  if (!rx || !ry) return null;
  const n = 180;
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push(applyCtm(ctm, cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
  }
  return { points, isClosed: true };
}

function sampleLine(el) {
  const ctm = el.getCTM();
  const x1 = parseFloat(el.getAttribute('x1') || 0);
  const y1 = parseFloat(el.getAttribute('y1') || 0);
  const x2 = parseFloat(el.getAttribute('x2') || 0);
  const y2 = parseFloat(el.getAttribute('y2') || 0);
  return { points: [applyCtm(ctm, x1, y1), applyCtm(ctm, x2, y2)], isClosed: false };
}

function samplePolyElement(el, forceClose) {
  const ctm = el.getCTM();
  const ptList = el.points;
  if (!ptList || ptList.length < 2) return null;
  const points = [];
  for (let i = 0; i < ptList.length; i++) {
    points.push(applyCtm(ctm, ptList[i].x, ptList[i].y));
  }
  return { points, isClosed: forceClose };
}

// ── DXF parsing helpers ──

function parseEntities(lines) {
  const entities = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === 'ENTITIES') { i++; break; }
    i++;
  }
  while (i < lines.length - 1) {
    const code = parseInt(lines[i].trim());
    const value = lines[i + 1].trim();
    if (code === 0 && value === 'ENDSEC') break;
    if (code === 0) {
      const entityType = value;
      i += 2;
      const props = [];
      while (i < lines.length - 1) {
        const nc = parseInt(lines[i].trim());
        if (nc === 0) break;
        props.push({ code: nc, value: lines[i + 1].trim() });
        i += 2;
      }

      // Handle POLYLINE/VERTEX chains
      if (entityType === 'POLYLINE') {
        const vertexProps = [];
        let closed = false;
        for (const p of props) {
          if (p.code === 70 && (parseInt(p.value) & 1)) closed = true;
        }
        while (i < lines.length - 1) {
          const vc = parseInt(lines[i].trim());
          const vv = lines[i + 1].trim();
          if (vc === 0 && vv === 'SEQEND') {
            i += 2;
            // Skip SEQEND's props
            while (i < lines.length - 1 && parseInt(lines[i].trim()) !== 0) i += 2;
            break;
          }
          if (vc === 0 && vv === 'VERTEX') {
            i += 2;
            const vp = [];
            while (i < lines.length - 1) {
              const nc2 = parseInt(lines[i].trim());
              if (nc2 === 0) break;
              vp.push({ code: nc2, value: lines[i + 1].trim() });
              i += 2;
            }
            vertexProps.push(vp);
          } else {
            break;
          }
        }
        entities.push({ type: 'POLYLINE', props, vertexProps, closed });
      } else {
        entities.push({ type: entityType, props });
      }
    } else {
      i += 2;
    }
  }
  return entities;
}

function getPropMap(props) {
  const map = {};
  const lists = {};
  for (const p of props) {
    if (lists[p.code]) {
      lists[p.code].push(p.value);
    } else if (map[p.code] !== undefined) {
      lists[p.code] = [map[p.code], p.value];
      delete map[p.code];
    } else {
      map[p.code] = p.value;
    }
  }
  return { map, lists };
}

function entityToPath(entity) {
  switch (entity.type) {
    case 'LINE': return parseDxfLine(entity);
    case 'LWPOLYLINE': return parseLWPolyline(entity);
    case 'POLYLINE': return parsePolylineEntity(entity);
    case 'CIRCLE': return parseDxfCircle(entity);
    case 'ARC': return parseDxfArc(entity);
    default: return null;
  }
}

function parseDxfLine(entity) {
  const { map } = getPropMap(entity.props);
  const x1 = parseFloat(map[10] || '0'), y1 = parseFloat(map[20] || '0');
  const x2 = parseFloat(map[11] || '0'), y2 = parseFloat(map[21] || '0');
  return { points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], isClosed: false };
}

function parseLWPolyline(entity) {
  const vertices = [];
  let cur = null;
  for (const p of entity.props) {
    if (p.code === 10) {
      if (cur) vertices.push(cur);
      cur = { x: parseFloat(p.value), y: 0, bulge: 0 };
    } else if (p.code === 20 && cur) {
      cur.y = parseFloat(p.value);
    } else if (p.code === 42 && cur) {
      cur.bulge = parseFloat(p.value);
    }
  }
  if (cur) vertices.push(cur);
  if (vertices.length < 2) return null;

  const { map } = getPropMap(entity.props);
  const flags = parseInt(map[70] || '0');
  const isClosed = (flags & 1) !== 0;

  const points = [];
  const count = isClosed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < count; i++) {
    const v = vertices[i];
    points.push({ x: v.x, y: v.y });
    if (Math.abs(v.bulge) > 1e-6) {
      const next = vertices[(i + 1) % vertices.length];
      points.push(...bulgeToArc(v.x, v.y, next.x, next.y, v.bulge));
    }
  }
  if (!isClosed) {
    const last = vertices[vertices.length - 1];
    points.push({ x: last.x, y: last.y });
  }

  return points.length >= 2 ? { points, isClosed } : null;
}

function parsePolylineEntity(entity) {
  const vertices = [];
  for (const vp of (entity.vertexProps || [])) {
    let x = 0, y = 0, bulge = 0;
    for (const p of vp) {
      if (p.code === 10) x = parseFloat(p.value);
      else if (p.code === 20) y = parseFloat(p.value);
      else if (p.code === 42) bulge = parseFloat(p.value);
    }
    vertices.push({ x, y, bulge });
  }
  if (vertices.length < 2) return null;

  const isClosed = entity.closed || false;
  const points = [];
  const count = isClosed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < count; i++) {
    const v = vertices[i];
    points.push({ x: v.x, y: v.y });
    if (Math.abs(v.bulge) > 1e-6) {
      const next = vertices[(i + 1) % vertices.length];
      points.push(...bulgeToArc(v.x, v.y, next.x, next.y, v.bulge));
    }
  }
  if (!isClosed) {
    const last = vertices[vertices.length - 1];
    points.push({ x: last.x, y: last.y });
  }

  return points.length >= 2 ? { points, isClosed } : null;
}

function parseDxfCircle(entity) {
  const { map } = getPropMap(entity.props);
  const cx = parseFloat(map[10] || '0');
  const cy = parseFloat(map[20] || '0');
  const r = parseFloat(map[40] || '0');
  if (r <= 0) return null;
  const n = 180;
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return { points, isClosed: true };
}

function parseDxfArc(entity) {
  const { map } = getPropMap(entity.props);
  const cx = parseFloat(map[10] || '0');
  const cy = parseFloat(map[20] || '0');
  const r = parseFloat(map[40] || '0');
  const startDeg = parseFloat(map[50] || '0');
  const endDeg = parseFloat(map[51] || '360');
  if (r <= 0) return null;

  const startAngle = startDeg * Math.PI / 180;
  const endAngle = endDeg * Math.PI / 180;
  let sweep = endAngle - startAngle;
  if (sweep <= 0) sweep += 2 * Math.PI;

  const n = Math.max(8, Math.ceil(sweep / (Math.PI / 36)));
  const points = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngle + (sweep * i) / n;
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return { points, isClosed: false };
}

function bulgeToArc(x1, y1, x2, y2, bulge) {
  const dx = x2 - x1, dy = y2 - y1;
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < 1e-10) return [];
  const sagitta = Math.abs(bulge) * chordLen / 2;
  const radius = (chordLen * chordLen / 4 + sagitta * sagitta) / (2 * sagitta);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const nx = -dy / chordLen, ny = dx / chordLen;
  const d = radius - sagitta;
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx + sign * d * nx, cy = my + sign * d * ny;

  const startAngle = Math.atan2(y1 - cy, x1 - cx);
  let sweep = Math.atan2(y2 - cy, x2 - cx) - startAngle;
  if (bulge > 0 && sweep < 0) sweep += 2 * Math.PI;
  if (bulge < 0 && sweep > 0) sweep -= 2 * Math.PI;

  const n = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const points = [];
  for (let i = 1; i < n; i++) {
    const a = startAngle + (sweep * i) / n;
    points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return points;
}

// ── Shared helpers ──

function computeBounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (const pt of p.points) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
