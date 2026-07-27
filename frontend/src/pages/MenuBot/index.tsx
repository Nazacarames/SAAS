import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Stack, Paper, Button, TextField, Select, MenuItem, FormControl,
  InputLabel, CircularProgress, IconButton, Alert, Switch, FormControlLabel,
  Chip, Divider, OutlinedInput,
} from '@mui/material';
import {
  Add as AddIcon, Delete as DeleteIcon, ArrowUpward as UpIcon, ArrowDownward as DownIcon,
  SmartToy as BotIcon,
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

// Menú Bot: flujo de bienvenida determinístico por WhatsApp (botones + listas),
// con acciones por opción: etapa, round-robin de asesores, nota interna, handoff.

interface SubItem {
  label: string; description: string; reply_text: string;
  stage_id: number | null; internal_note: string; after: 'human' | 'ai';
}
interface Option {
  label: string; reply_text: string; stage_id: number | null;
  assign_users: number[]; internal_note: string; after: 'human' | 'ai';
  submenu: { text: string; button: string; items: SubItem[] } | null;
}
interface Flow {
  enabled: boolean; greeting: string; reopen_hours: number;
  no_match: 'ai' | 'menu'; options: Option[];
}

const emptyOption = (): Option => ({
  label: '', reply_text: '', stage_id: null, assign_users: [], internal_note: '', after: 'human', submenu: null,
});
const emptySub = (): SubItem => ({
  label: '', description: '', reply_text: '', stage_id: null, internal_note: '', after: 'human',
});
const defaultFlow = (): Flow => ({
  enabled: false, greeting: '¡Hola! 👋 ¿En qué te podemos ayudar hoy?', reopen_hours: 24, no_match: 'ai', options: [],
});

const MenuBot = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flow, setFlow] = useState<Flow>(defaultFlow());
  const [stats, setStats] = useState<Record<string, number>>({});
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [stages, setStages] = useState<{ id: number; name: string }[]>([]);
  const [hasWa, setHasWa] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/menu-bot');
      const f = data.flow || {};
      setFlow({ ...defaultFlow(), ...f, options: (f.options || []).map((o: any) => ({ ...emptyOption(), ...o })) });
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

  const save = async (override?: Partial<Flow>) => {
    setSaving(true);
    try {
      const { data } = await api.put('/menu-bot', { flow: { ...flow, ...(override || {}) } });
      setFlow({ ...defaultFlow(), ...data.flow, options: (data.flow.options || []).map((o: any) => ({ ...emptyOption(), ...o })) });
      toast.success('Menú guardado');
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
  const moveOpt = (i: number, dir: -1 | 1) =>
    setFlow(f => {
      const opts = [...f.options];
      const t = i + dir;
      if (t < 0 || t >= opts.length) return f;
      [opts[i], opts[t]] = [opts[t], opts[i]];
      return { ...f, options: opts };
    });

  const labelMax = flow.options.length <= 3 ? 20 : 24;
  const clicksOf = (key: string) => stats[key] || 0;
  const menuSent = clicksOf('menu_sent');

  const AfterSelect = ({ value, onChange }: { value: string; onChange: (v: 'human' | 'ai') => void }) => (
    <FormControl size="small" sx={{ minWidth: 220 }}>
      <InputLabel>Después de esta opción</InputLabel>
      <Select label="Después de esta opción" value={value || 'human'} onChange={e => onChange(e.target.value as any)}>
        <MenuItem value="human">Pasa a un humano (IA pausada)</MenuItem>
        <MenuItem value="ai">Sigue el agente IA</MenuItem>
      </Select>
    </FormControl>
  );

  const StageSelect = ({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) => (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel>Mover a etapa</InputLabel>
      <Select label="Mover a etapa" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <MenuItem value="">(no mover)</MenuItem>
        {stages.map(s => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
      </Select>
    </FormControl>
  );

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box sx={{ p: 3, maxWidth: 980 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}><BotIcon sx={{ mr: 1, verticalAlign: 'text-bottom' }} />Menú Bot</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 640 }}>
            Menú de bienvenida con botones de WhatsApp. Cada opción puede mover al lead de etapa,
            asignarlo a un asesor (round-robin), dejar una nota interna y derivar a un humano o al agente IA.
            Lo que el cliente escriba fuera del menú lo responde el agente IA.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <FormControlLabel
            control={<Switch checked={flow.enabled} onChange={e => setFlow(f => ({ ...f, enabled: e.target.checked }))} />}
            label={flow.enabled ? 'Activo' : 'Inactivo'} />
          <Button variant="contained" onClick={() => save()} disabled={saving}>
            {saving ? <CircularProgress size={20} /> : 'Guardar'}
          </Button>
        </Stack>
      </Stack>

      {!hasWa && <Alert severity="info" sx={{ mb: 2 }}>Conectá un canal de WhatsApp en <b>Canales</b> para que el menú funcione.</Alert>}

      {menuSent > 0 && (
        <Paper sx={{ p: 1.5, mb: 2 }}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            <Chip size="small" label={`Menú enviado: ${menuSent}`} />
            {flow.options.map((o, i) => {
              const n = clicksOf(`o${i}`);
              const pct = menuSent ? Math.round((n / menuSent) * 100) : 0;
              return <Chip key={i} size="small" variant="outlined" label={`${o.label || `Opción ${i + 1}`}: ${n} (${pct}%)`} />;
            })}
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2, mb: 2 }}>
        <TextField label="Mensaje de bienvenida" fullWidth multiline minRows={2} value={flow.greeting}
          onChange={e => setFlow(f => ({ ...f, greeting: e.target.value }))}
          helperText="Se envía con los botones del menú en la primera conversación (o al volver después del tiempo configurado)" />
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <FormControl size="small" sx={{ minWidth: 260 }}>
            <InputLabel>Si escribe otra cosa</InputLabel>
            <Select label="Si escribe otra cosa" value={flow.no_match}
              onChange={e => setFlow(f => ({ ...f, no_match: e.target.value as any }))}>
              <MenuItem value="ai">Responde el agente IA (recomendado)</MenuItem>
              <MenuItem value="menu">Repetir el menú</MenuItem>
            </Select>
          </FormControl>
          <TextField size="small" type="number" label="Re-saludar tras (horas)" sx={{ width: 180 }}
            value={flow.reopen_hours}
            onChange={e => setFlow(f => ({ ...f, reopen_hours: Number(e.target.value) || 24 }))} />
        </Stack>
      </Paper>

      {flow.options.map((opt, i) => (
        <Paper key={i} sx={{ p: 2, mb: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
            <Typography sx={{ fontWeight: 600 }}>Opción {i + 1}{clicksOf(`o${i}`) > 0 && ` · ${clicksOf(`o${i}`)} clicks`}</Typography>
            <Stack direction="row">
              <IconButton size="small" onClick={() => moveOpt(i, -1)}><UpIcon fontSize="small" /></IconButton>
              <IconButton size="small" onClick={() => moveOpt(i, 1)}><DownIcon fontSize="small" /></IconButton>
              <IconButton size="small" onClick={() => setFlow(f => ({ ...f, options: f.options.filter((_, j) => j !== i) }))}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Stack>
          <Stack spacing={1.5}>
            <TextField size="small" label={`Texto del botón (máx ${labelMax})`} value={opt.label}
              inputProps={{ maxLength: labelMax }} sx={{ maxWidth: 340 }}
              onChange={e => setOpt(i, { label: e.target.value })} />

            <FormControlLabel
              control={<Switch checked={!!opt.submenu}
                onChange={e => setOpt(i, { submenu: e.target.checked ? { text: 'Elegí una opción', button: 'Opciones', items: [emptySub()] } : null })} />}
              label="Abre un submenú (lista de WhatsApp, ej: sucursales)" />

            {!opt.submenu && (
              <>
                <TextField size="small" label="Respuesta al cliente" fullWidth multiline minRows={2}
                  value={opt.reply_text} onChange={e => setOpt(i, { reply_text: e.target.value })}
                  helperText="Podés usar {asesor} para el nombre del asignado" />
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                  <StageSelect value={opt.stage_id} onChange={v => setOpt(i, { stage_id: v })} />
                  <FormControl size="small" sx={{ minWidth: 260 }}>
                    <InputLabel>Asignar asesores (round-robin)</InputLabel>
                    <Select multiple label="Asignar asesores (round-robin)" input={<OutlinedInput label="Asignar asesores (round-robin)" />}
                      value={opt.assign_users}
                      onChange={e => setOpt(i, { assign_users: (e.target.value as number[]) })}
                      renderValue={(sel) => (sel as number[]).map(id => users.find(u => u.id === id)?.name || id).join(', ')}>
                      {users.map(u => <MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <AfterSelect value={opt.after} onChange={v => setOpt(i, { after: v })} />
                </Stack>
                <TextField size="small" label="Nota interna para el equipo (opcional)" fullWidth
                  value={opt.internal_note} onChange={e => setOpt(i, { internal_note: e.target.value })} />
              </>
            )}

            {opt.submenu && (
              <Box sx={{ pl: 2, borderLeft: '2px solid rgba(255,255,255,0.1)' }}>
                <Stack direction="row" spacing={2} sx={{ mb: 1.5 }}>
                  <TextField size="small" label="Texto del submenú" value={opt.submenu.text} sx={{ flex: 1 }}
                    onChange={e => setOpt(i, { submenu: { ...opt.submenu!, text: e.target.value } })} />
                  <TextField size="small" label="Botón de la lista" value={opt.submenu.button} sx={{ width: 180 }}
                    inputProps={{ maxLength: 20 }}
                    onChange={e => setOpt(i, { submenu: { ...opt.submenu!, button: e.target.value } })} />
                </Stack>
                {opt.submenu.items.map((it, j) => (
                  <Paper key={j} variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        Ítem {j + 1}{clicksOf(`s${i}:${j}`) > 0 && ` · ${clicksOf(`s${i}:${j}`)} clicks`}
                      </Typography>
                      <IconButton size="small" onClick={() => setOpt(i, { submenu: { ...opt.submenu!, items: opt.submenu!.items.filter((_, m) => m !== j) } })}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                    <Stack spacing={1.5}>
                      <Stack direction="row" spacing={2}>
                        <TextField size="small" label="Nombre (máx 24)" value={it.label} inputProps={{ maxLength: 24 }}
                          onChange={e => setSub(i, j, { label: e.target.value })} />
                        <TextField size="small" label="Descripción (máx 72)" value={it.description} sx={{ flex: 1 }}
                          inputProps={{ maxLength: 72 }} onChange={e => setSub(i, j, { description: e.target.value })} />
                      </Stack>
                      <TextField size="small" label="Respuesta al cliente" fullWidth multiline minRows={2}
                        value={it.reply_text} onChange={e => setSub(i, j, { reply_text: e.target.value })} />
                      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                        <StageSelect value={it.stage_id} onChange={v => setSub(i, j, { stage_id: v })} />
                        <AfterSelect value={it.after} onChange={v => setSub(i, j, { after: v })} />
                      </Stack>
                      <TextField size="small" label="Nota interna (opcional)" fullWidth
                        value={it.internal_note} onChange={e => setSub(i, j, { internal_note: e.target.value })} />
                    </Stack>
                  </Paper>
                ))}
                <Button size="small" startIcon={<AddIcon />}
                  onClick={() => setOpt(i, { submenu: { ...opt.submenu!, items: [...opt.submenu!.items, emptySub()] } })}>
                  Agregar ítem
                </Button>
              </Box>
            )}
          </Stack>
        </Paper>
      ))}

      <Button startIcon={<AddIcon />} variant="outlined" disabled={flow.options.length >= 10}
        onClick={() => setFlow(f => ({ ...f, options: [...f.options, emptyOption()] }))}>
        Agregar opción al menú
      </Button>
      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        Con 3 opciones o menos el menú usa botones de WhatsApp; con más, una lista desplegable.
        Cada respuesta del bot incluye "Volver al menú". Los clicks quedan registrados arriba.
      </Typography>
    </Box>
  );
};

export default MenuBot;
