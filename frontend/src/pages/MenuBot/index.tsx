import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react';
import {
  Box, Typography, Stack, Button, TextField, Select, MenuItem, FormControl,
  InputLabel, CircularProgress, Alert, Switch, FormControlLabel, Chip, Drawer,
  IconButton, OutlinedInput, Divider,
} from '@mui/material';
import {
  Add as AddIcon, Delete as DeleteIcon, SmartToy as BotIcon, Bolt as BoltIcon,
  ListAlt as ListIcon, Flag as FlagIcon, Close as CloseIcon, Chat as ChatIcon,
  PlayArrow as PlayIcon, RestartAlt as RestartIcon,
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  applyNodeChanges, type Node, type Edge, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import api from '../../services/api';

// Menú Bot — editor visual de flujos (estilo Make/Langflow) sobre React Flow.
// El canvas edita el mismo flow_json del motor determinístico: nada cambia
// en el backend, solo la forma de armarlo.

interface SubItem {
  label: string; description: string; reply_text: string;
  stage_id: number | null; internal_note: string; after: 'human' | 'ai';
  notify_number: string; notify_template: string;
}
interface Option {
  label: string; reply_text: string; stage_id: number | null;
  assign_users: number[]; rr_replies: string[]; internal_note: string; after: 'human' | 'ai';
  notify_number: string; notify_template: string; rr_notify_numbers: string[];
  submenu: { text: string; button: string; items: SubItem[] } | null;
}
interface Flow {
  enabled: boolean; greeting: string; reopen_hours: number;
  no_match: 'ai' | 'menu'; options: Option[]; channel_ids: number[];
}

const emptyOption = (): Option => ({
  label: 'Nueva opción', reply_text: '', stage_id: null, assign_users: [], rr_replies: [], internal_note: '', after: 'human',
  notify_number: '', notify_template: '', rr_notify_numbers: [], submenu: null,
});
const emptySub = (): SubItem => ({
  label: 'Nuevo ítem', description: '', reply_text: '', stage_id: null, internal_note: '', after: 'human',
  notify_number: '', notify_template: '',
});
const defaultFlow = (): Flow => ({
  enabled: false, greeting: '¡Hola! 👋 ¿En qué te podemos ayudar hoy?', reopen_hours: 24, no_match: 'ai', options: [],
  channel_ids: [],
});

// ── Nodo custom ───────────────────────────────────────────────────────
const KIND_STYLE: Record<string, { color: string; icon: JSX.Element; title: string }> = {
  trigger: { color: '#34D399', icon: <BoltIcon sx={{ fontSize: 15 }} />, title: 'Disparador' },
  menu: { color: '#4C8DF6', icon: <ChatIcon sx={{ fontSize: 15 }} />, title: 'Menú de bienvenida' },
  option: { color: '#E8A020', icon: <BotIcon sx={{ fontSize: 15 }} />, title: 'Opción' },
  list: { color: '#B76BE0', icon: <ListIcon sx={{ fontSize: 15 }} />, title: 'Lista (submenú)' },
  item: { color: '#E5C438', icon: <ListIcon sx={{ fontSize: 15 }} />, title: 'Ítem' },
  msg: { color: '#56A8D6', icon: <ChatIcon sx={{ fontSize: 15 }} />, title: 'Mensaje' },
  fallback: { color: '#7A9CC6', icon: <BotIcon sx={{ fontSize: 15 }} />, title: 'Texto libre' },
  fin: { color: '#EF5350', icon: <FlagIcon sx={{ fontSize: 15 }} />, title: 'Fin' },
};

// memo + selección nativa de React Flow: el nodo no se re-renderiza durante
// pan/zoom/drag de otros nodos (antes el canvas entero se rearmaba por frame)
const MbNode = memo(({ data, selected }: any) => {
  if (data.kind === 'add') {
    return (
      <Box sx={{
        width: 200, py: 1.2, textAlign: 'center', borderRadius: 1.5, cursor: 'pointer',
        border: '1.5px dashed rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.5)',
        '&:hover': { borderColor: '#34D399', color: '#34D399' },
      }}>
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
        <Typography sx={{ fontSize: '0.78rem', fontWeight: 600 }}>+ {data.label}</Typography>
      </Box>
    );
  }
  const st = KIND_STYLE[data.kind] || KIND_STYLE.option;
  return (
    <Box sx={{
      position: 'relative',
      width: 230, bgcolor: '#1A1D24', border: `1px solid ${selected ? st.color : 'rgba(255,255,255,0.12)'}`,
      borderTop: `3px solid ${st.color}`, borderRadius: 1.5, cursor: 'pointer',
      boxShadow: selected ? `0 0 12px ${st.color}44` : '0 2px 10px rgba(0,0,0,0.35)',
      '&:hover': { borderColor: st.color, '& .mb-del': { opacity: 1 } },
    }}>
      {data.kind !== 'trigger' && <Handle type="target" position={Position.Left} style={{ background: st.color, width: 8, height: 8 }} />}
      {data.onDelete && (
        <IconButton className="mb-del" size="small"
          onClick={(e) => { e.stopPropagation(); data.onDelete(); }}
          sx={{ position: 'absolute', top: 1, right: 1, p: 0.2, opacity: 0, transition: 'opacity 120ms',
                color: 'rgba(255,255,255,0.35)', '&:hover': { color: '#EF5350' } }}>
          <CloseIcon sx={{ fontSize: 13 }} />
        </IconButton>
      )}
      <Stack direction="row" spacing={0.7} alignItems="center" sx={{ px: 1.2, pt: 0.8, color: st.color }}>
        {st.icon}
        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {st.title}
        </Typography>
        {data.badge !== undefined && (
          <Chip size="small" label={data.badge} sx={{ ml: 'auto !important', mr: data.onDelete ? 1.5 : 0, height: 16, fontSize: '0.6rem', bgcolor: `${st.color}22`, color: st.color }} />
        )}
      </Stack>
      <Box sx={{ px: 1.2, pb: 1, pt: 0.4 }}>
        <Typography sx={{ fontSize: '0.78rem', color: '#E8E6E1', fontWeight: 600, lineHeight: 1.25 }} noWrap>
          {data.label}
        </Typography>
        {data.sub && (
          <Typography sx={{ fontSize: '0.66rem', color: 'rgba(255,255,255,0.45)', mt: 0.3 }} noWrap>
            {data.sub}
          </Typography>
        )}
      </Box>
      {data.kind !== 'fin' && data.kind !== 'fallback' && <Handle type="source" position={Position.Right} style={{ background: st.color, width: 8, height: 8 }} />}
    </Box>
  );
});
const nodeTypes = { mb: MbNode };

const MenuBot = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flow, setFlow] = useState<Flow>(defaultFlow());
  const [stats, setStats] = useState<Record<string, number>>({});
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [stages, setStages] = useState<{ id: number; name: string }[]>([]);
  const [hasWa, setHasWa] = useState(true);
  const [waChannels, setWaChannels] = useState<{ id: number; name: string; display: string; status: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // posiciones arrastradas en un ref: mover un nodo no debe rearmar el grafo
  const draggedRef = useRef<Record<string, { x: number; y: number }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/menu-bot');
      const f = data.flow || {};
      setFlow({ ...defaultFlow(), ...f, channel_ids: f.channel_ids || [],
                options: (f.options || []).map((o: any) => ({ ...emptyOption(), ...o, label: o.label || '' })) });
      setStats(data.stats || {});
      setUsers(data.users || []);
      setStages(data.stages || []);
      setHasWa(!!data.has_whatsapp);
      setWaChannels(data.channels || []);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al cargar el Menú Bot');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/menu-bot', { flow });
      setFlow({ ...defaultFlow(), ...data.flow, channel_ids: data.flow.channel_ids || [],
                options: (data.flow.options || []).map((o: any) => ({ ...emptyOption(), ...o })) });
      toast.success('Flujo guardado');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  const setOpt = (i: number, patch: Partial<Option>) =>
    setFlow(f => ({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const setSub = (i: number, j: number, patch: Partial<SubItem>) =>
    setFlow(f => ({
      ...f,
      options: f.options.map((o, k) => k !== i || !o.submenu ? o : ({
        ...o, submenu: { ...o.submenu, items: o.submenu.items.map((it, m) => (m === j ? { ...it, ...patch } : it)) },
      })),
    }));

  const handleDelete = useCallback((id: string) => {
    if (!window.confirm('¿Eliminar este paso del flujo?')) return;
    setSelected(null);
    const om = id.match(/^o(\d+)$/);
    const sm = id.match(/^s(\d+):(\d+)$/);
    if (om) {
      const i = Number(om[1]);
      setFlow(f => ({ ...f, options: f.options.filter((_, j) => j !== i) }));
    } else if (sm) {
      const [i, j] = [Number(sm[1]), Number(sm[2])];
      setFlow(f => ({
        ...f,
        options: f.options.map((o, k) => {
          if (k !== i || !o.submenu) return o;
          const items = o.submenu.items.filter((_, m) => m !== j);
          return items.length ? { ...o, submenu: { ...o.submenu, items } } : { ...o, submenu: null };
        }),
      }));
    }
  }, []);

  const addOption = useCallback((withSubmenu: boolean) => {
    const n = flow.options.length;
    if (n >= 10) return;
    const o = emptyOption();
    if (withSubmenu) o.submenu = { text: 'Elegí una opción', button: 'Opciones', items: [emptySub()] };
    setFlow(f => ({ ...f, options: [...f.options, o] }));
    setSelected(`o${n}`);
  }, [flow.options.length]);

  const addItem = useCallback((i: number) => {
    const o = flow.options[i];
    if (!o?.submenu || o.submenu.items.length >= 10) return;
    const j = o.submenu.items.length;
    setOpt(i, { submenu: { ...o.submenu, items: [...o.submenu.items, emptySub()] } });
    setSelected(`s${i}:${j}`);
  }, [flow]);

  // ── Grafo ───────────────────────────────────────────────────────────
  // Solo se rearma cuando cambia el flujo/stats, nunca durante drag/pan/zoom
  const graph = useMemo(() => {
    const N: Node[] = [];
    const E: Edge[] = [];
    const mk = (id: string, x: number, y: number, kind: string, label: string, sub?: string, badge?: number, deletable?: boolean) =>
      N.push({
        id, type: 'mb', position: { x, y },
        data: { kind, label, sub, badge, onDelete: deletable ? () => handleDelete(id) : undefined },
      });
    const edge = (a: string, b: string, color: string, label?: string) =>
      E.push({ id: `${a}-${b}`, source: a, target: b, label,
               style: { stroke: color, strokeWidth: 1.5, strokeDasharray: '7 5' },
               labelStyle: { fill: '#E8E6E1', fontSize: 10 }, labelBgStyle: { fill: '#1A1D24' } });

    mk('trigger', 0, 180, 'trigger', 'Conversación nueva', `WhatsApp · re-saludo ${flow.reopen_hours}h`);
    mk('menu', 300, 170, 'menu', flow.greeting.split('\n')[0] || 'Bienvenida',
       `${flow.options.length} opciones`, stats.menu_sent);
    edge('trigger', 'menu', '#34D399');

    let y = 30;
    flow.options.forEach((o, i) => {
      const oid = `o${i}`;
      const chips = o.submenu ? `lista: ${o.submenu.items.length} ítems`
        : [o.stage_id ? '→etapa' : '', o.assign_users.length > 1 ? `RR ×${o.assign_users.length}` : (o.assign_users.length ? 'asigna' : ''),
           o.notify_number ? '🔔 avisa' : '',
           o.after === 'human' ? 'humano' : 'IA'].filter(Boolean).join(' · ');
      mk(oid, 620, y, 'option', o.label || `Opción ${i + 1}`, chips, stats[oid], true);
      edge('menu', oid, '#4C8DF6', stats[oid] ? `${stats[oid]}` : undefined);

      if (o.submenu) {
        const lid = `l${i}`;
        mk(lid, 940, y, 'list', o.submenu.text, `botón: ${o.submenu.button}`);
        edge(oid, lid, '#E8A020');
        const rows = o.submenu.items.length + (o.submenu.items.length < 10 ? 1 : 0);
        let iy = y - Math.max(0, rows - 1) * 55;
        o.submenu.items.forEach((it, j) => {
          const iid = `s${i}:${j}`;
          mk(iid, 1260, iy, 'item', it.label || `Ítem ${j + 1}`,
             [it.description, it.notify_number ? '🔔 avisa' : '', it.after === 'human' ? 'humano' : 'IA'].filter(Boolean).join(' · '), stats[iid], true);
          edge(lid, iid, '#B76BE0', stats[iid] ? `${stats[iid]}` : undefined);
          mk(`fin_${iid}`, 1580, iy, 'fin', it.after === 'human' ? 'Pasa a humano (IA pausada)' : 'Sigue el agente IA',
             [it.notify_number ? '🔔 avisa' : '', '«Volver al menú» → inicio'].filter(Boolean).join(' · '));
          edge(iid, `fin_${iid}`, '#EF5350');
          iy += 110;
        });
        if (o.submenu.items.length < 10) {
          mk(`add_item_${i}`, 1260, iy, 'add', 'Agregar ítem');
          edge(lid, `add_item_${i}`, 'rgba(255,255,255,0.25)');
        }
        y += Math.max(160, rows * 110 + 40);
      } else if (o.assign_users.length > 1 && o.rr_replies.some(t => (t || '').trim())) {
        // mensaje propio por asesora (round-robin), como los nodos "Mensaje" de Kommo
        let my = y - (o.assign_users.length - 1) * 55;
        o.assign_users.forEach((uid, k) => {
          const mid = `m${i}:${k}`;
          const uname = users.find(u => u.id === uid)?.name || `Asesor ${k + 1}`;
          mk(mid, 940, my, 'msg', `Mensaje de ${uname}`, (o.rr_replies[k] || o.reply_text || '').split('\n')[0]);
          edge(oid, mid, '#56A8D6', `RR 1/${o.assign_users.length}`);
          mk(`fin_${mid}`, 1260, my, 'fin', o.after === 'human' ? 'Pasa a humano (IA pausada)' : 'Sigue el agente IA',
             [(o.rr_notify_numbers[k] || o.notify_number) ? `🔔 avisa a ${uname}` : '', '«Volver al menú» → inicio'].filter(Boolean).join(' · '));
          edge(mid, `fin_${mid}`, '#EF5350');
          my += 110;
        });
        y += Math.max(160, o.assign_users.length * 110 + 40);
      } else {
        mk(`fin_${oid}`, 940, y, 'fin', o.after === 'human' ? 'Pasa a humano (IA pausada)' : 'Sigue el agente IA',
           [o.notify_number ? '🔔 avisa' : '', '«Volver al menú» → inicio'].filter(Boolean).join(' · '));
        edge(oid, `fin_${oid}`, '#EF5350');
        y += 160;
      }
    });
    if (flow.options.length < 10) {
      mk('add_opt', 620, y, 'add', 'Agregar paso');
      edge('menu', 'add_opt', 'rgba(255,255,255,0.25)');
      y += 90;
    }
    mk('fallback', 620, y + 10, 'fallback',
       flow.no_match === 'ai' ? 'Responde el agente IA' : 'Se repite el menú',
       'cualquier otro mensaje');
    edge('menu', 'fallback', '#7A9CC6');
    return { nodes: N, edges: E };
  }, [flow, stats, users, handleDelete]);

  // Nodos en estado propio: el drag solo mueve el nodo tocado, sin rearmar nada
  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    setNodes(prev => graph.nodes.map(n => {
      const old = prev.find(p => p.id === n.id);
      const drag = draggedRef.current[n.id];
      return { ...n, position: drag || n.position, selected: old?.selected || false };
    }));
  }, [graph]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) if (c.type === 'position' && c.position) draggedRef.current[c.id] = c.position;
    setNodes(nds => applyNodeChanges(changes, nds));
  }, []);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const m = node.id.match(/^add_item_(\d+)$/);
    if (m) { addItem(Number(m[1])); return; }
    setSelected(node.id); // 'add_opt' abre el selector de pasos en el panel
  }, [addItem]);

  // ── Simulador (Probar bot) ─────────────────────────────────────────
  type SimMsg = { from: 'bot' | 'user'; text: string; chips?: string[]; buttons?: { id: string; label: string }[] };
  const [testOpen, setTestOpen] = useState(false);
  const [sim, setSim] = useState<SimMsg[]>([]);
  const [simInput, setSimInput] = useState('');
  const rrSim = useRef<Record<string, number>>({});

  const simMenu = useCallback((): SimMsg => ({
    from: 'bot', text: flow.greeting,
    buttons: flow.options.map((o, i) => ({ id: `o${i}`, label: o.label || `Opción ${i + 1}` })),
  }), [flow]);

  const openTest = () => { rrSim.current = {}; setSim([simMenu()]); setTestOpen(true); };

  const simRun = (node: Option | SubItem, opt?: Option, rrKey?: string): SimMsg => {
    let reply = node.reply_text;
    let rrNotify = '';
    const chips: string[] = [];
    if (opt && opt.assign_users.length) {
      const k = (rrSim.current[rrKey!] = (rrSim.current[rrKey!] ?? -1) + 1) % opt.assign_users.length;
      const uname = users.find(u => u.id === opt.assign_users[k])?.name || `asesor ${k + 1}`;
      reply = ((opt.rr_replies[k] || '').trim() || reply).replace('{asesor}', uname);
      chips.push(`Asignado a ${uname}${opt.assign_users.length > 1 ? ' (round-robin)' : ''}`);
      rrNotify = (opt.rr_notify_numbers[k] || '').trim();
      if (rrNotify) chips.push(`🔔 Aviso a ${uname} al +${rrNotify}`);
    }
    if (node.stage_id) chips.push(`Movido a etapa: ${stages.find(s => s.id === node.stage_id)?.name || node.stage_id}`);
    if (node.internal_note) chips.push('Deja nota interna en el hilo');
    if (!rrNotify && node.notify_number) chips.push(`🔔 Aviso por WhatsApp al +${node.notify_number}`);
    chips.push(node.after === 'human' ? 'IA pausada: sigue un humano' : 'El agente IA sigue la charla');
    return { from: 'bot', text: reply || '(sin respuesta configurada)', chips, buttons: [{ id: 'root', label: '↩ Volver al menú' }] };
  };

  const simClick = (id: string, label: string) => {
    setSim(prev => {
      const next: SimMsg[] = [...prev, { from: 'user', text: label }];
      if (id === 'root') return [...next, simMenu()];
      const om = id.match(/^o(\d+)$/);
      const sm = id.match(/^s(\d+):(\d+)$/);
      if (om) {
        const o = flow.options[Number(om[1])];
        if (!o) return next;
        if (o.submenu) {
          return [...next, {
            from: 'bot', text: o.submenu.text,
            buttons: o.submenu.items.map((it, j) => ({ id: `s${om[1]}:${j}`, label: it.label || `Ítem ${j + 1}` })),
          }];
        }
        return [...next, simRun(o, o, `o${om[1]}`)];
      }
      if (sm) {
        const it = flow.options[Number(sm[1])]?.submenu?.items[Number(sm[2])];
        if (it) return [...next, simRun(it)];
      }
      return next;
    });
  };

  const simFree = () => {
    const t = simInput.trim();
    if (!t) return;
    setSimInput('');
    setSim(prev => flow.no_match === 'menu'
      ? [...prev, { from: 'user', text: t }, simMenu()]
      : [...prev, { from: 'user', text: t }, { from: 'bot', text: '🤖 Texto libre: acá responde el agente IA con la base de conocimiento.' }]);
  };

  // ── Editores (drawer) ──────────────────────────────────────────────
  const StageSelect = ({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) => (
    <FormControl size="small" fullWidth>
      <InputLabel>Mover a etapa</InputLabel>
      <Select label="Mover a etapa" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <MenuItem value="">(no mover)</MenuItem>
        {stages.map(s => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </Select>
    </FormControl>
  );
  const AfterSelect = ({ value, onChange }: { value: string; onChange: (v: 'human' | 'ai') => void }) => (
    <FormControl size="small" fullWidth>
      <InputLabel>Después de esta opción</InputLabel>
      <Select label="Después de esta opción" value={value || 'human'} onChange={e => onChange(e.target.value as any)}>
        <MenuItem value="human">Pasa a un humano (IA pausada)</MenuItem>
        <MenuItem value="ai">Sigue el agente IA</MenuItem>
      </Select>
    </FormControl>
  );

  const labelMax = flow.options.length <= 3 ? 20 : 24;

  const renderDrawer = () => {
    if (!selected) return null;
    let title = ''; let body: JSX.Element | null = null;

    if (selected === 'trigger') {
      title = 'Disparador';
      body = (
        <Stack spacing={2}>
          <Alert severity="info">El flujo arranca solo con la primera conversación de WhatsApp, o cuando el cliente vuelve a escribir después del tiempo configurado.</Alert>
          <FormControl size="small" fullWidth>
            <InputLabel>Canales donde corre el bot</InputLabel>
            <Select multiple label="Canales donde corre el bot" input={<OutlinedInput label="Canales donde corre el bot" />}
              value={flow.channel_ids}
              onChange={e => setFlow(f => ({ ...f, channel_ids: e.target.value as number[] }))}
              renderValue={(sel) => (sel as number[]).length
                ? (sel as number[]).map(id => waChannels.find(c => c.id === id)?.display || id).join(', ')
                : 'Todos'}>
              {waChannels.map(c => (
                <MenuItem key={c.id} value={c.id}>
                  {c.display} — {c.name}{c.status !== 'active' ? ' (inactivo)' : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
            Sin selección corre en todos los WhatsApp de la cuenta.
          </Typography>
          <TextField size="small" type="number" label="Re-saludar tras (horas)" value={flow.reopen_hours}
            onChange={e => setFlow(f => ({ ...f, reopen_hours: Number(e.target.value) || 24 }))} />
        </Stack>
      );
    } else if (selected === 'menu') {
      title = 'Menú de bienvenida';
      body = (
        <Stack spacing={2}>
          <TextField label="Mensaje de bienvenida" fullWidth multiline minRows={4} value={flow.greeting}
            onChange={e => setFlow(f => ({ ...f, greeting: e.target.value }))} />
          <Button startIcon={<AddIcon />} variant="outlined" disabled={flow.options.length >= 10}
            onClick={() => setFlow(f => ({ ...f, options: [...f.options, emptyOption()] }))}>
            Agregar opción
          </Button>
          <Typography variant="caption" color="text.secondary">
            Hasta 3 opciones se muestran como botones; con más, como lista de WhatsApp.
          </Typography>
        </Stack>
      );
    } else if (selected === 'fallback') {
      title = 'Texto libre (sin match)';
      body = (
        <FormControl size="small" fullWidth>
          <InputLabel>Si escribe otra cosa</InputLabel>
          <Select label="Si escribe otra cosa" value={flow.no_match}
            onChange={e => setFlow(f => ({ ...f, no_match: e.target.value as any }))}>
            <MenuItem value="ai">Responde el agente IA (recomendado)</MenuItem>
            <MenuItem value="menu">Repetir el menú</MenuItem>
          </Select>
        </FormControl>
      );
    } else if (/^o\d+$/.test(selected)) {
      const i = Number(selected.slice(1));
      const o = flow.options[i];
      if (!o) return null;
      title = `Opción ${i + 1}`;
      body = (
        <Stack spacing={2}>
          <TextField size="small" label={`Texto del botón (máx ${labelMax})`} value={o.label}
            inputProps={{ maxLength: labelMax }} onChange={e => setOpt(i, { label: e.target.value })} />
          <FormControlLabel
            control={<Switch checked={!!o.submenu}
              onChange={e => setOpt(i, { submenu: e.target.checked ? { text: 'Elegí una opción', button: 'Opciones', items: [emptySub()] } : null })} />}
            label="Abre un submenú (lista)" />
          {!o.submenu && (
            <>
              <TextField size="small" label="Respuesta al cliente" fullWidth multiline minRows={3}
                value={o.reply_text} onChange={e => setOpt(i, { reply_text: e.target.value })}
                helperText="{asesor} = nombre del asignado" />
              <StageSelect value={o.stage_id} onChange={v => setOpt(i, { stage_id: v })} />
              <FormControl size="small" fullWidth>
                <InputLabel>Asignar asesores (round-robin)</InputLabel>
                <Select multiple label="Asignar asesores (round-robin)" input={<OutlinedInput label="Asignar asesores (round-robin)" />}
                  value={o.assign_users}
                  onChange={e => setOpt(i, { assign_users: e.target.value as number[] })}
                  renderValue={(sel) => (sel as number[]).map(id => users.find(u => u.id === id)?.name || id).join(', ')}>
                  {users.map(u => <MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>)}
                </Select>
              </FormControl>
              {o.assign_users.length > 1 && o.assign_users.map((uid, k) => (
                <TextField key={uid} size="small" fullWidth multiline minRows={3}
                  label={`Mensaje si atiende ${users.find(u => u.id === uid)?.name || `asesor ${k + 1}`}`}
                  value={o.rr_replies[k] || ''}
                  onChange={e => {
                    const rr = [...o.rr_replies]; rr[k] = e.target.value;
                    setOpt(i, { rr_replies: rr });
                  }}
                  helperText={k === 0 ? 'Opcional: mensaje propio por asesor (vacío = respuesta general)' : undefined} />
              ))}
              <AfterSelect value={o.after} onChange={v => setOpt(i, { after: v })} />
              <TextField size="small" label="Nota interna (opcional)" fullWidth value={o.internal_note}
                onChange={e => setOpt(i, { internal_note: e.target.value })} />
              <TextField size="small" label="🔔 Avisar por WhatsApp al número (opcional)" placeholder="5491122334455" fullWidth
                value={o.notify_number} onChange={e => setOpt(i, { notify_number: e.target.value.replace(/\D/g, '') })}
                helperText="Le avisa al asesor que tiene un nuevo cliente (nombre y teléfono)" />
              {o.notify_number && (
                <TextField size="small" label="Plantilla de Meta del aviso (opcional)" fullWidth
                  value={o.notify_template} onChange={e => setOpt(i, { notify_template: e.target.value })}
                  helperText="Sin plantilla, el aviso solo llega si el asesor escribió a la línea en las últimas 24h (regla de Meta). Con plantilla aprobada llega siempre: {{1}}=cliente, {{2}}=teléfono" />
              )}
            </>
          )}
          <Divider />
          <Button color="error" startIcon={<DeleteIcon />}
            onClick={() => { setSelected(null); setFlow(f => ({ ...f, options: f.options.filter((_, j) => j !== i) })); }}>
            Eliminar opción
          </Button>
        </Stack>
      );
    } else if (selected === 'add_opt') {
      title = 'Agregar paso';
      body = (
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">¿Qué querés agregar al menú?</Typography>
          <Button variant="outlined" startIcon={<ChatIcon />} onClick={() => addOption(false)}>
            Opción con respuesta
          </Button>
          <Button variant="outlined" startIcon={<ListIcon />} onClick={() => addOption(true)}>
            Opción con submenú (lista)
          </Button>
          <Alert severity="info">
            Dentro de cada paso podés sumar acciones: mover de etapa, asignar asesores round-robin,
            avisarle al asesor por WhatsApp que tiene un cliente por atender, dejar nota interna y
            pasar a humano o seguir con el agente IA.
          </Alert>
        </Stack>
      );
    } else if (/^m\d+:\d+$/.test(selected)) {
      const [i, k] = selected.slice(1).split(':').map(Number);
      const o = flow.options[i];
      if (!o) return null;
      const uname = users.find(u => u.id === o.assign_users[k])?.name || `Asesor ${k + 1}`;
      title = `Mensaje de ${uname}`;
      body = (
        <Stack spacing={2}>
          <TextField size="small" label={`Se envía cuando el round-robin asigna a ${uname}`} fullWidth multiline minRows={5}
            value={o.rr_replies[k] || ''}
            onChange={e => {
              const rr = [...o.rr_replies]; rr[k] = e.target.value;
              setOpt(i, { rr_replies: rr });
            }}
            helperText="Vacío = usa la respuesta general de la opción. Siempre incluye el botón «Volver al menú»." />
        </Stack>
      );
    } else if (/^l\d+$/.test(selected)) {
      const i = Number(selected.slice(1));
      const o = flow.options[i];
      if (!o?.submenu) return null;
      title = 'Lista (submenú)';
      body = (
        <Stack spacing={2}>
          <TextField size="small" label="Texto del submenú" value={o.submenu.text}
            onChange={e => setOpt(i, { submenu: { ...o.submenu!, text: e.target.value } })} />
          <TextField size="small" label="Botón de la lista (máx 20)" value={o.submenu.button} inputProps={{ maxLength: 20 }}
            onChange={e => setOpt(i, { submenu: { ...o.submenu!, button: e.target.value } })} />
          <Button startIcon={<AddIcon />} variant="outlined" disabled={o.submenu.items.length >= 10}
            onClick={() => setOpt(i, { submenu: { ...o.submenu!, items: [...o.submenu!.items, emptySub()] } })}>
            Agregar ítem
          </Button>
        </Stack>
      );
    } else if (/^s\d+:\d+$/.test(selected)) {
      const [i, j] = selected.slice(1).split(':').map(Number);
      const it = flow.options[i]?.submenu?.items[j];
      if (!it) return null;
      title = `Ítem: ${it.label || j + 1}`;
      body = (
        <Stack spacing={2}>
          <TextField size="small" label="Nombre (máx 24)" value={it.label} inputProps={{ maxLength: 24 }}
            onChange={e => setSub(i, j, { label: e.target.value })} />
          <TextField size="small" label="Descripción (máx 72)" value={it.description} inputProps={{ maxLength: 72 }}
            onChange={e => setSub(i, j, { description: e.target.value })} />
          <TextField size="small" label="Respuesta al cliente" fullWidth multiline minRows={3}
            value={it.reply_text} onChange={e => setSub(i, j, { reply_text: e.target.value })} />
          <StageSelect value={it.stage_id} onChange={v => setSub(i, j, { stage_id: v })} />
          <AfterSelect value={it.after} onChange={v => setSub(i, j, { after: v })} />
          <TextField size="small" label="Nota interna (opcional)" fullWidth value={it.internal_note}
            onChange={e => setSub(i, j, { internal_note: e.target.value })} />
          <TextField size="small" label="🔔 Avisar por WhatsApp al número (opcional)" placeholder="5491122334455" fullWidth
            value={it.notify_number} onChange={e => setSub(i, j, { notify_number: e.target.value.replace(/\D/g, '') })}
            helperText="Le avisa al asesor de esta sucursal que tiene un nuevo cliente" />
          {it.notify_number && (
            <TextField size="small" label="Plantilla de Meta del aviso (opcional)" fullWidth
              value={it.notify_template} onChange={e => setSub(i, j, { notify_template: e.target.value })}
              helperText="Sin plantilla, el aviso solo llega dentro de la ventana de 24h de Meta" />
          )}
          <Divider />
          <Button color="error" startIcon={<DeleteIcon />}
            onClick={() => {
              setSelected(null);
              setOpt(i, { submenu: { ...flow.options[i].submenu!, items: flow.options[i].submenu!.items.filter((_, m) => m !== j) } });
            }}>
            Eliminar ítem
          </Button>
        </Stack>
      );
    } else if (selected.startsWith('fin_')) {
      const ref = selected.slice(4);
      const om = ref.match(/^o(\d+)$/);
      const mm = ref.match(/^m(\d+):(\d+)$/);
      const sm = ref.match(/^s(\d+):(\d+)$/);
      title = 'Fin del recorrido';
      if (om || mm) {
        const i = Number((om || mm)![1]);
        const o = flow.options[i];
        if (!o) return null;
        const k = mm ? Number(mm[2]) : -1;
        const uname = k >= 0 ? (users.find(u => u.id === o.assign_users[k])?.name || `asesor ${k + 1}`) : '';
        const notifyVal = k >= 0 ? (o.rr_notify_numbers[k] || '') : o.notify_number;
        body = (
          <Stack spacing={2}>
            <AfterSelect value={o.after} onChange={v => setOpt(i, { after: v })} />
            <TextField size="small" fullWidth placeholder="5491122334455"
              label={k >= 0 ? `🔔 Avisar a ${uname} al número (opcional)` : '🔔 Avisar por WhatsApp al número (opcional)'}
              value={notifyVal}
              onChange={e => {
                const v = e.target.value.replace(/\D/g, '');
                if (k >= 0) { const rr = [...o.rr_notify_numbers]; rr[k] = v; setOpt(i, { rr_notify_numbers: rr }); }
                else setOpt(i, { notify_number: v });
              }}
              helperText={k >= 0
                ? `Cuando el round-robin asigna a ${uname}, le llega el aviso de nuevo cliente a ese WhatsApp`
                : 'Le llega "Nuevo cliente por atender" con nombre y teléfono del cliente'} />
            {!!notifyVal && (
              <TextField size="small" label="Plantilla de Meta del aviso (opcional)" fullWidth
                value={o.notify_template} onChange={e => setOpt(i, { notify_template: e.target.value })}
                helperText="Sin plantilla, el aviso solo llega si el asesor escribió a la línea en las últimas 24h (regla de Meta). Con plantilla aprobada llega siempre" />
            )}
            <Alert severity="info">El botón «Volver al menú» siempre lleva al cliente al mensaje inicial.</Alert>
          </Stack>
        );
      } else if (sm) {
        const [i, j] = [Number(sm[1]), Number(sm[2])];
        const it = flow.options[i]?.submenu?.items[j];
        if (!it) return null;
        body = (
          <Stack spacing={2}>
            <AfterSelect value={it.after} onChange={v => setSub(i, j, { after: v })} />
            <TextField size="small" fullWidth placeholder="5491122334455" label="🔔 Avisar por WhatsApp al número (opcional)"
              value={it.notify_number}
              onChange={e => setSub(i, j, { notify_number: e.target.value.replace(/\D/g, '') })}
              helperText="Le avisa al asesor de esta sucursal que tiene un nuevo cliente" />
            {!!it.notify_number && (
              <TextField size="small" label="Plantilla de Meta del aviso (opcional)" fullWidth
                value={it.notify_template} onChange={e => setSub(i, j, { notify_template: e.target.value })}
                helperText="Sin plantilla, el aviso solo llega dentro de la ventana de 24h de Meta" />
            )}
            <Alert severity="info">El botón «Volver al menú» siempre lleva al cliente al mensaje inicial.</Alert>
          </Stack>
        );
      } else {
        body = <Alert severity="info">Configurá qué pasa después (humano o IA) en el nodo anterior. Toda respuesta del bot incluye el botón «Volver al menú».</Alert>;
      }
    }

    return (
      <Drawer anchor="right" open onClose={() => setSelected(null)}
        PaperProps={{ sx: { width: 360, p: 2, bgcolor: '#14161C' } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
          <IconButton size="small" onClick={() => setSelected(null)}><CloseIcon fontSize="small" /></IconButton>
        </Stack>
        {body}
      </Drawer>
    );
  };

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box sx={{ height: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2.5, py: 1.5 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700 }}><BotIcon sx={{ mr: 1, verticalAlign: 'text-bottom' }} />Menú Bot</Typography>
          <Typography variant="caption" color="text.secondary">
            Tocá un nodo para editarlo · arrastrá para reacomodar · los números son clicks reales
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} alignItems="center">
          {stats.menu_sent > 0 && <Chip size="small" label={`Menú enviado: ${stats.menu_sent}`} />}
          <FormControlLabel
            control={<Switch checked={flow.enabled} onChange={e => setFlow(f => ({ ...f, enabled: e.target.checked }))} />}
            label={flow.enabled ? 'Activo' : 'Inactivo'} />
          <Button variant="outlined" startIcon={<AddIcon />} disabled={flow.options.length >= 10}
            onClick={() => addOption(false)}>
            Opción
          </Button>
          <Button variant="outlined" color="success" startIcon={<PlayIcon />} onClick={openTest}>
            Probar
          </Button>
          <Button variant="contained" onClick={save} disabled={saving}>
            {saving ? <CircularProgress size={20} /> : 'Guardar'}
          </Button>
        </Stack>
      </Stack>

      {!hasWa && <Alert severity="info" sx={{ mx: 2.5, mb: 1 }}>Conectá un canal de WhatsApp en <b>Canales</b> para que el flujo funcione.</Alert>}

      <Box sx={{ flex: 1, mx: 2.5, mb: 2.5, borderRadius: 2, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        <ReactFlow
          nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onNodeClick={onNodeClick}
          nodesConnectable={false} deleteKeyCode={null} fitView proOptions={{ hideAttribution: true }}
          style={{ background: '#0F1116' }}>
          <Background color="rgba(255,255,255,0.07)" gap={22} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => KIND_STYLE[(n.data as any)?.kind]?.color || '#555'}
            style={{ background: '#14161C' }} maskColor="rgba(15,17,22,0.75)" />
        </ReactFlow>
      </Box>

      {renderDrawer()}

      <Drawer anchor="right" open={testOpen} onClose={() => setTestOpen(false)}
        PaperProps={{ sx: { width: 400, p: 2, bgcolor: '#14161C', display: 'flex', flexDirection: 'column' } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
          <Typography sx={{ fontWeight: 700 }}><PlayIcon sx={{ fontSize: 18, verticalAlign: 'text-bottom', mr: 0.5, color: '#34D399' }} />Probar el bot</Typography>
          <Stack direction="row" spacing={0.5}>
            <IconButton size="small" title="Reiniciar" onClick={() => { rrSim.current = {}; setSim([simMenu()]); }}>
              <RestartIcon fontSize="small" />
            </IconButton>
            <IconButton size="small" onClick={() => setTestOpen(false)}><CloseIcon fontSize="small" /></IconButton>
          </Stack>
        </Stack>
        <Alert severity="info" sx={{ mb: 1, py: 0 }}>
          <Typography variant="caption">Simula el flujo tal como está en el editor (aunque no lo hayas guardado). No envía nada por WhatsApp.</Typography>
        </Alert>
        <Box sx={{ flex: 1, overflowY: 'auto', pr: 0.5 }}>
          {sim.map((m, idx) => (
            <Box key={idx} sx={{ display: 'flex', justifyContent: m.from === 'user' ? 'flex-end' : 'flex-start', mb: 1 }}>
              <Box sx={{
                maxWidth: '88%', px: 1.4, py: 1, borderRadius: 2, fontSize: '0.82rem', whiteSpace: 'pre-wrap',
                bgcolor: m.from === 'user' ? '#0B5A48' : '#1F232B', color: '#E8E6E1',
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                {m.text}
                {m.chips?.map(c => (
                  <Typography key={c} sx={{ fontSize: '0.68rem', color: '#9BE8C9', mt: 0.5 }}>• {c}</Typography>
                ))}
                {m.buttons && (
                  <Stack spacing={0.6} sx={{ mt: 1 }}>
                    {m.buttons.map(b => (
                      <Button key={b.id} size="small" variant="outlined" onClick={() => simClick(b.id, b.label)}
                        sx={{ textTransform: 'none', fontSize: '0.75rem', justifyContent: 'flex-start' }}>
                        {b.label}
                      </Button>
                    ))}
                  </Stack>
                )}
              </Box>
            </Box>
          ))}
        </Box>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <TextField size="small" fullWidth placeholder="Escribí como el cliente…" value={simInput}
            onChange={e => setSimInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && simFree()} />
          <Button variant="contained" onClick={simFree}>Enviar</Button>
        </Stack>
      </Drawer>
    </Box>
  );
};

export default MenuBot;
