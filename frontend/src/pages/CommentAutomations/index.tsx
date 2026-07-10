import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Stack, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Select, MenuItem, FormControl, InputLabel, CircularProgress, IconButton, Tooltip, Alert,
  Switch, FormControlLabel,
} from '@mui/material';
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, Refresh as RefreshIcon,
  Instagram as InstagramIcon, Facebook as FacebookIcon,
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

// Comment-to-DM: cuando alguien comenta una publicación de IG/FB con cierta
// palabra clave, el agente lo contacta por mensaje directo en esa red.

interface Automation {
  id: number; channel_type: 'instagram' | 'messenger'; name: string;
  keywords: string; post_id: string; agent_generated: boolean;
  message_text: string; enabled: boolean; dm_count: number;
}
interface LogRow {
  channel_type: string; commenter_name: string; comment_text: string;
  dm_text: string; ok: boolean | null; error: string; created_at: string;
}

const CHANNEL_META = {
  instagram: { label: 'Instagram', fg: '#E1487F', bg: 'rgba(225,72,127,0.12)', icon: <InstagramIcon sx={{ fontSize: 15 }} /> },
  messenger: { label: 'Facebook', fg: '#4C8DF6', bg: 'rgba(76,141,246,0.12)', icon: <FacebookIcon sx={{ fontSize: 15 }} /> },
};

const emptyForm = {
  channel_type: 'instagram' as 'instagram' | 'messenger',
  name: '', keywords: '', post_id: '', agent_generated: true, message_text: '', enabled: true,
};

const CommentAutomations = () => {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Automation[]>([]);
  const [channels, setChannels] = useState<{ instagram: boolean; messenger: boolean }>({ instagram: false, messenger: false });
  const [logRows, setLogRows] = useState<LogRow[]>([]);
  const [showLog, setShowLog] = useState(false);

  const [target, setTarget] = useState<Automation | null | 'new'>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/comment-automations');
      setRows(data.automations || []);
      setChannels(data.channels || { instagram: false, messenger: false });
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al cargar las reglas');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const { data } = await api.get('/comment-automations/log');
      setLogRows(data.log || []);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { load(); loadLog(); }, [load, loadLog]);

  const anyConnected = channels.instagram || channels.messenger;

  const openCreate = () => {
    setForm({ ...emptyForm, channel_type: channels.instagram ? 'instagram' : 'messenger' });
    setTarget('new');
  };
  const openEdit = (a: Automation) => {
    setForm({
      channel_type: a.channel_type, name: a.name, keywords: a.keywords, post_id: a.post_id,
      agent_generated: a.agent_generated, message_text: a.message_text, enabled: a.enabled,
    });
    setTarget(a);
  };

  const save = async () => {
    if (!form.agent_generated && !form.message_text.trim()) {
      toast.error('Escribí el mensaje fijo o activá el modo agente');
      return;
    }
    setSaving(true);
    try {
      const { data } = target === 'new'
        ? await api.post('/comment-automations', form)
        : await api.put(`/comment-automations/${(target as Automation).id}`, form);
      if (data.warning) toast.warning(data.warning, { autoClose: 10000 });
      toast.success(target === 'new' ? 'Regla creada — ya está escuchando comentarios' : 'Regla actualizada');
      setTarget(null);
      await load(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (a: Automation) => {
    try {
      const { data } = await api.put(`/comment-automations/${a.id}`, {
        channel_type: a.channel_type, name: a.name, keywords: a.keywords, post_id: a.post_id,
        agent_generated: a.agent_generated, message_text: a.message_text, enabled: !a.enabled,
      });
      if (data.warning) toast.warning(data.warning, { autoClose: 10000 });
      setRows(prev => prev.map(r => (r.id === a.id ? { ...r, enabled: !a.enabled } : r)));
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo cambiar');
    }
  };

  const remove = async (a: Automation) => {
    if (!window.confirm(`¿Eliminar la regla "${a.name || a.keywords || a.id}"?`)) return;
    try {
      await api.delete(`/comment-automations/${a.id}`);
      toast.success('Regla eliminada');
      await load(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo eliminar');
    }
  };

  const ChannelChip = ({ type }: { type: 'instagram' | 'messenger' }) => {
    const m = CHANNEL_META[type];
    return <Chip size="small" icon={m.icon} label={m.label} sx={{ bgcolor: m.bg, color: m.fg, '& .MuiChip-icon': { color: m.fg } }} />;
  };

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Comentarios → DM</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 640 }}>
            Cuando alguien comenta una publicación de Instagram o Facebook con la palabra clave que
            definas, el agente le manda un mensaje directo automáticamente. La conversación sigue en
            la bandeja cuando la persona responde.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Tooltip title="Actualizar"><IconButton onClick={() => { load(true); loadLog(); }}><RefreshIcon /></IconButton></Tooltip>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} disabled={!anyConnected}>
            Nueva regla
          </Button>
        </Stack>
      </Stack>

      {!loading && !anyConnected && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Para usar esta función conectá primero Instagram o Facebook (Messenger) en la sección <b>Canales</b>.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : rows.length === 0 ? (
        anyConnected && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">
              Todavía no hay reglas. Creá la primera: por ejemplo, que quien comente
              «precio» o «info» en tus publicaciones reciba un DM del agente al instante.
            </Typography>
          </Paper>
        )
      ) : (
        <Paper sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Red</TableCell>
                <TableCell>Nombre</TableCell>
                <TableCell>Palabras clave</TableCell>
                <TableCell>Publicación</TableCell>
                <TableCell>Mensaje</TableCell>
                <TableCell align="center">DMs enviados</TableCell>
                <TableCell align="center">Activa</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(a => (
                <TableRow key={a.id} hover>
                  <TableCell><ChannelChip type={a.channel_type} /></TableCell>
                  <TableCell>{a.name || <Typography variant="body2" color="text.secondary">—</Typography>}</TableCell>
                  <TableCell sx={{ maxWidth: 220 }}>
                    {a.keywords
                      ? a.keywords.split(',').filter(k => k.trim()).map(k => (
                          <Chip key={k} size="small" label={k.trim()} sx={{ mr: 0.5, mb: 0.5 }} />
                        ))
                      : <Chip size="small" label="cualquier comentario" variant="outlined" />}
                  </TableCell>
                  <TableCell>{a.post_id ? <Tooltip title={a.post_id}><span>1 publicación</span></Tooltip> : 'Todas'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={a.agent_generated ? 'Agente IA' : 'Texto fijo'}
                      sx={a.agent_generated ? { bgcolor: 'rgba(52,211,153,0.12)', color: '#34D399' } : {}} />
                  </TableCell>
                  <TableCell align="center">{a.dm_count}</TableCell>
                  <TableCell align="center">
                    <Switch size="small" checked={a.enabled} onChange={() => toggleEnabled(a)} />
                  </TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => openEdit(a)}><EditIcon fontSize="small" /></IconButton>
                    <IconButton size="small" onClick={() => remove(a)}><DeleteIcon fontSize="small" /></IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      <Box sx={{ mt: 3 }}>
        <Button size="small" onClick={() => setShowLog(v => !v)}>
          {showLog ? 'Ocultar actividad' : `Ver actividad reciente (${logRows.length})`}
        </Button>
        {showLog && (
          <Paper sx={{ mt: 1, overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Fecha</TableCell>
                  <TableCell>Red</TableCell>
                  <TableCell>Comentó</TableCell>
                  <TableCell>Comentario</TableCell>
                  <TableCell>DM enviado</TableCell>
                  <TableCell>Estado</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {logRows.length === 0 && (
                  <TableRow><TableCell colSpan={6}><Typography variant="body2" color="text.secondary">Sin actividad todavía</Typography></TableCell></TableRow>
                )}
                {logRows.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</TableCell>
                    <TableCell><ChannelChip type={(l.channel_type as 'instagram' | 'messenger') || 'instagram'} /></TableCell>
                    <TableCell>{l.commenter_name || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 200 }}><Typography variant="body2" noWrap title={l.comment_text}>{l.comment_text}</Typography></TableCell>
                    <TableCell sx={{ maxWidth: 260 }}><Typography variant="body2" noWrap title={l.dm_text}>{l.dm_text}</Typography></TableCell>
                    <TableCell>
                      {l.ok
                        ? <Chip size="small" label="Enviado" sx={{ bgcolor: 'rgba(52,211,153,0.12)', color: '#34D399' }} />
                        : <Tooltip title={l.error || ''}><Chip size="small" label="Falló" sx={{ bgcolor: 'rgba(239,83,80,0.12)', color: '#EF5350' }} /></Tooltip>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </Box>

      <Dialog open={target !== null} onClose={() => !saving && setTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{target === 'new' ? 'Nueva regla de comentarios' : 'Editar regla'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Red social</InputLabel>
              <Select label="Red social" value={form.channel_type}
                onChange={e => setForm(f => ({ ...f, channel_type: e.target.value as any }))}>
                <MenuItem value="instagram" disabled={!channels.instagram}>Instagram{!channels.instagram && ' (no conectado)'}</MenuItem>
                <MenuItem value="messenger" disabled={!channels.messenger}>Facebook{!channels.messenger && ' (no conectado)'}</MenuItem>
              </Select>
            </FormControl>
            <TextField label="Nombre de la regla (opcional)" size="small" fullWidth value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ej: Campaña lanzamiento" />
            <TextField label="Palabras clave" size="small" fullWidth value={form.keywords}
              onChange={e => setForm(f => ({ ...f, keywords: e.target.value }))}
              placeholder="precio, info, quiero"
              helperText="Separadas por coma. Si queda vacío, responde a cualquier comentario. No distingue mayúsculas ni tildes." />
            <TextField label="ID de publicación (opcional)" size="small" fullWidth value={form.post_id}
              onChange={e => setForm(f => ({ ...f, post_id: e.target.value }))}
              helperText="Dejalo vacío para aplicar a todas las publicaciones" />
            <FormControlLabel
              control={<Switch checked={form.agent_generated} onChange={e => setForm(f => ({ ...f, agent_generated: e.target.checked }))} />}
              label="El agente IA redacta el mensaje según el comentario" />
            <TextField
              label={form.agent_generated ? 'Instrucciones extra para el agente (opcional)' : 'Mensaje fijo'}
              size="small" fullWidth multiline minRows={3} value={form.message_text}
              onChange={e => setForm(f => ({ ...f, message_text: e.target.value }))}
              placeholder={form.agent_generated
                ? 'Ej: ofrecele el catálogo de otoño y pedile su zona'
                : 'Hola {nombre}! Vimos tu comentario…'}
              helperText={form.agent_generated
                ? 'El agente usa su persona + el comentario para escribir el DM'
                : 'Podés usar {nombre} y {comentario}'} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTarget(null)} disabled={saving}>Cancelar</Button>
          <Button variant="contained" onClick={save} disabled={saving}>
            {saving ? <CircularProgress size={20} /> : 'Guardar'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default CommentAutomations;
