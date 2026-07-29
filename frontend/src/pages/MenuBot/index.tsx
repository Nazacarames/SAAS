import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box, Typography, Stack, Button, TextField, Select, MenuItem, FormControl,
  InputLabel, CircularProgress, Alert, Switch, FormControlLabel, Chip, Drawer,
  IconButton, OutlinedInput, Divider,
} from '@mui/material';
import {
  Add as AddIcon, Delete as DeleteIcon, SmartToy as BotIcon, Bolt as BoltIcon,
  ListAlt as ListIcon, Flag as FlagIcon, Close as CloseIcon, Chat as ChatIcon,
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
}
interface Option {
  label: string; reply_text: string; stage_id: number | null;
  assign_users: number[]; rr_replies: string[]; internal_note: string; after: 'human' | 'ai';
  submenu: { text: string; button: string; items: SubItem[] } | null;
}
interface Flow {
  enabled: boolean; greeting: string; reopen_hours: number;
  no_match: 'ai' | 'menu'; options: Option[];
}

const emptyOption = (): Option => ({
  label: 'Nueva opción', reply_text: '', stage_id: null, assign_users: [], rr_replies: [], internal_note: '', after: 'human', submenu: null,
});
const emptySub = (): SubItem => ({
  label: 'Nuevo ítem', description: '', reply_text: '', stage_id: null, internal_note: '', after: 'human',
});
const defaultFlow = (): Flow => ({
  enabled: false, greeting: '¡Hola! 👋 ¿En qué te podemos ayudar hoy?', reopen_hours: 24, no_match: 'ai', options: [],
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

const MbNode = ({ data }: any) => {
  const st = KIND_STYLE[data.kind] || KIND_STYLE.option;
  return (
    <Box onClick={data.onClick} sx={{
      width: 230, bgcolor: '#1A1D24', border: `1px solid ${data.selected ? st.color : 'rgba(255,255,255,0.12)'}`,
      borderTop: `3px solid ${st.color}`, borderRadius: 1.5, cursor: 'pointer',
      boxShadow: data.selected ? `0 0 12px ${st.color}44` : '0 2px 10px rgba(0,0,0,0.35)',
      '&:hover': { borderColor: st.color },
    }}>
      {data.kind !== 'trigger' && <Handle type="target" position={Position.Left} style={{ background: st.color, width: 8, height: 8 }} />}
      <Stack direction="row" spacing={0.7} alignItems="center" sx={{ px: 1.2, pt: 0.8, color: st.color }}>
        {st.icon}
        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {st.title}
        </Typography>
        {data.badge !== undefined && (
          <Chip size="small" label={data.badge} sx={{ ml: 'auto !important', height: 16, fontSize: '0.6rem', bgcolor: `${st.color}22`, color: st.color }} />
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
};
const nodeTypes = { mb: MbNode };

const MenuBot = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flow, setFlow] = useState<Flow>(defaultFlow());
  const [stats, setStats] = useState<Record<string, number>>({});
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [stages, setStages] = useState<{ id: number; name: string }[]>([]);
  const [hasWa, setHasWa] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/menu-bot');
      const f = data.flow || {};
      setFlow({ ...defaultFlow(), ...f, options: (f.options || []).map((o: any) => ({ ...emptyOption(), ...o, label: o.label || '' })) });
      setStats(data.stats || {});
      setUsers(data.users || []);
      setStages(data.stages || []);
      setHasWa(!!data.has_whatsapp);
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
      setFlow({ ...defaultFlow(), ...data.flow, options: (data.flow.options || []).map((o: any) => ({ ...emptyOption(), ...o })) });
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

  // ── Grafo ───────────────────────────────────────────────────────────
  const { nodes, edges } = useMemo(() => {
    const N: Node[] = [];
    const E: Edge[] = [];
    const pos = (id: string, x: number, y: number) => dragged[id] || { x, y };
    const mk = (id: string, x: number, y: number, kind: string, label: string, sub?: string, badge?: number) =>
      N.push({
        id, type: 'mb', position: pos(id, x, y),
        data: { kind, label, sub, badge, selected: selected === id, onClick: () => setSelected(id) },
      });
    const edge = (a: string, b: string, color: string, label?: string) =>
      E.push({ id: `${a}-${b}`, source: a, target: b, animated: true, label,
               style: { stroke: color, strokeWidth: 1.5 },
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
           o.after === 'human' ? 'humano' : 'IA'].filter(Boolean).join(' · ');
      mk(oid, 620, y, 'option', o.label || `Opción ${i + 1}`, chips, stats[oid]);
      edge('menu', oid, '#4C8DF6', stats[oid] ? `${stats[oid]}` : undefined);

      if (o.submenu) {
        const lid = `l${i}`;
        mk(lid, 940, y, 'list', o.submenu.text, `botón: ${o.submenu.button}`);
        edge(oid, lid, '#E8A020');
        let iy = y - Math.max(0, (o.submenu.items.length - 1)) * 55;
        o.submenu.items.forEach((it, j) => {
          const iid = `s${i}:${j}`;
          mk(iid, 1260, iy, 'item', it.label || `Ítem ${j + 1}`,
             [it.description, it.after === 'human' ? 'humano' : 'IA'].filter(Boolean).join(' · '), stats[iid]);
          edge(lid, iid, '#B76BE0', stats[iid] ? `${stats[iid]}` : undefined);
          mk(`fin_${iid}`, 1580, iy, 'fin', it.after === 'human' ? 'Pasa a humano (IA pausada)' : 'Sigue el agente IA');
          edge(iid, `fin_${iid}`, '#EF5350');
          iy += 110;
        });
        y += Math.max(160, o.submenu.items.length * 110 + 40);
      } else if (o.assign_users.length > 1 && o.rr_replies.some(t => (t || '').trim())) {
        // mensaje propio por asesora (round-robin), como los nodos "Mensaje" de Kommo
        let my = y - (o.assign_users.length - 1) * 55;
        o.assign_users.forEach((uid, k) => {
          const mid = `m${i}:${k}`;
          const uname = users.find(u => u.id === uid)?.name || `Asesor ${k + 1}`;
          mk(mid, 940, my, 'msg', `Mensaje de ${uname}`, (o.rr_replies[k] || o.reply_text || '').split('\n')[0]);
          edge(oid, mid, '#56A8D6', `RR 1/${o.assign_users.length}`);
          mk(`fin_${mid}`, 1260, my, 'fin', o.after === 'human' ? 'Pasa a humano (IA pausada)' : 'Sigue el agente IA');
          edge(mid, `fin_${mid}`, '#EF5350');
          my += 110;
        });
        y += Math.max(160, o.assign_users.length * 110 + 40);
      } else {
        mk(`fin_${oid}`, 940, y, 'fin', o.after === 'human' ? 'Pasa a humano (IA pausada)' : 'Sigue el agente IA');
        edge(oid, `fin_${oid}`, '#EF5350');
        y += 160;
      }
    });
    mk('fallback', 620, y + 10, 'fallback',
       flow.no_match === 'ai' ? 'Responde el agente IA' : 'Se repite el menú',
       'cualquier otro mensaje');
    edge('menu', 'fallback', '#7A9CC6');
    return { nodes: N, edges: E };
  }, [flow, stats, selected, dragged, users]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = applyNodeChanges(changes, nodes);
    const patch: Record<string, { x: number; y: number }> = {};
    for (const n of moved) patch[n.id] = n.position;
    setDragged(d => ({ ...d, ...patch }));
  }, [nodes]);

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
            </>
          )}
          <Divider />
          <Button color="error" startIcon={<DeleteIcon />}
            onClick={() => { setSelected(null); setFlow(f => ({ ...f, options: f.options.filter((_, j) => j !== i) })); }}>
            Eliminar opción
          </Button>
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
      title = 'Fin del recorrido';
      body = <Alert severity="info">Configurá qué pasa después (humano o IA) en el nodo anterior. Toda respuesta del bot incluye el botón "Volver al menú".</Alert>;
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
            onClick={() => setFlow(f => ({ ...f, options: [...f.options, emptyOption()] }))}>
            Opción
          </Button>
          <Button variant="contained" onClick={save} disabled={saving}>
            {saving ? <CircularProgress size={20} /> : 'Guardar'}
          </Button>
        </Stack>
      </Stack>

      {!hasWa && <Alert severity="info" sx={{ mx: 2.5, mb: 1 }}>Conectá un canal de WhatsApp en <b>Canales</b> para que el flujo funcione.</Alert>}

      <Box sx={{ flex: 1, mx: 2.5, mb: 2.5, borderRadius: 2, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          nodesConnectable={false} fitView proOptions={{ hideAttribution: true }}
          style={{ background: '#0F1116' }}>
          <Background color="rgba(255,255,255,0.07)" gap={22} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => KIND_STYLE[(n.data as any)?.kind]?.color || '#555'}
            style={{ background: '#14161C' }} maskColor="rgba(15,17,22,0.75)" />
        </ReactFlow>
      </Box>

      {renderDrawer()}
    </Box>
  );
};

export default MenuBot;
