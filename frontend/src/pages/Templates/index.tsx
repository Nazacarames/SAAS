import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Stack, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Select, MenuItem, FormControl, InputLabel, CircularProgress, IconButton, Tooltip, Alert,
} from '@mui/material';
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, Refresh as RefreshIcon,
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

// Plantillas oficiales de WhatsApp (Meta): lo que se crea acá va a revisión
// de Meta y, aprobado, sirve para reenganches y mensajes fuera de la ventana 24h.

interface WabaTemplate {
  id: string; name: string; status: string; category: string; language: string;
  body: string; footer: string; rejected_reason: string;
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  APPROVED: { bg: 'rgba(52,211,153,0.12)', fg: '#34D399', label: 'Aprobado' },
  PENDING: { bg: 'rgba(232,160,32,0.12)', fg: '#E8A020', label: 'En revisión' },
  REJECTED: { bg: 'rgba(239,83,80,0.12)', fg: '#EF5350', label: 'Rechazado' },
  PAUSED: { bg: 'rgba(255,255,255,0.08)', fg: 'rgba(255,255,255,0.5)', label: 'Pausado' },
};

const countVars = (body: string) => {
  const m = body.match(/\{\{(\d+)\}\}/g) || [];
  return new Set(m).size;
};

const Templates = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState<WabaTemplate[]>([]);

  // dialog crear/editar
  const [target, setTarget] = useState<WabaTemplate | null | 'new'>(null);
  const [fName, setFName] = useState('');
  const [fCategory, setFCategory] = useState('MARKETING');
  const [fLanguage, setFLanguage] = useState('es_AR');
  const [fBody, setFBody] = useState('');
  const [fFooter, setFFooter] = useState('');
  const [fExamples, setFExamples] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/channels/waba-templates');
      if (!data.ok) { setError(data.error || 'Sin canal de WhatsApp activo'); setTemplates([]); }
      else { setError(''); setTemplates(data.templates || []); }
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Error al cargar templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setFName(''); setFCategory('MARKETING'); setFLanguage('es_AR');
    setFBody(''); setFFooter(''); setFExamples([]);
    setTarget('new');
  };

  const openEdit = (t: WabaTemplate) => {
    if (t.status === 'PENDING') { toast.info('Meta no permite editar mientras está en revisión'); return; }
    setFName(t.name); setFCategory(t.category); setFLanguage(t.language);
    setFBody(t.body); setFFooter(t.footer);
    setFExamples(Array(countVars(t.body)).fill(''));
    setTarget(t);
  };

  const onBodyChange = (v: string) => {
    setFBody(v);
    const n = countVars(v);
    setFExamples(prev => Array.from({ length: n }, (_, i) => prev[i] || ''));
  };

  const save = async () => {
    const nVars = countVars(fBody);
    if (nVars > 0 && fExamples.some(e => !e.trim())) {
      toast.error('Completá un ejemplo por cada variable — Meta lo exige para aprobar');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: fName, category: fCategory, language: fLanguage,
        body: fBody, footer: fFooter, example_params: fExamples,
      };
      if (target === 'new') {
        await api.post('/channels/waba-templates', body);
        toast.success('Template enviado a revisión de Meta (suele aprobar en minutos)');
      } else if (target) {
        await api.put(`/channels/waba-templates/${target.id}`, body);
        toast.success('Template editado — vuelve a revisión de Meta');
      }
      setTarget(null);
      await load(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Meta rechazó la operación');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: WabaTemplate) => {
    if (!confirm(`¿Eliminar el template "${t.name}"? Si algo lo usa (ej: reenganche) dejará de enviarse.`)) return;
    try {
      await api.delete(`/channels/waba-templates/${t.name}`);
      toast.success('Template eliminado');
      await load(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al eliminar');
    }
  };

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: '#E8A020' }} /></Box>;

  return (
    <Box sx={{ maxWidth: 1000, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Box>
          <Typography sx={{ fontFamily: '"Sora", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2' }}>
            Templates de WhatsApp
          </Typography>
          <Typography sx={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.4)' }}>
            Plantillas oficiales de Meta — necesarias para escribirle a un contacto fuera de la ventana de 24 h (reenganches, avisos)
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Tooltip title="Actualizar estado desde Meta">
            <IconButton onClick={() => load(true)}><RefreshIcon sx={{ fontSize: 18 }} /></IconButton>
          </Tooltip>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} sx={{ fontSize: '0.82rem' }}>
            Crear template
          </Button>
        </Stack>
      </Stack>

      {error ? (
        <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert>
      ) : (
        <Paper sx={{ mt: 2, borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', overflow: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {['Nombre', 'Contenido', 'Categoría', 'Idioma', 'Estado', ''].map(h => (
                  <TableCell key={h} sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', fontWeight: 700 }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {templates.length === 0 ? (
                <TableRow><TableCell colSpan={6} sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.82rem', py: 3 }}>
                  Sin templates todavía. Creá el primero — por ejemplo, uno de reenganche para leads inactivos.
                </TableCell></TableRow>
              ) : templates.map(t => {
                const st = STATUS_STYLE[t.status] || STATUS_STYLE.PAUSED;
                return (
                  <TableRow key={t.id}>
                    <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.76rem', whiteSpace: 'nowrap' }}>{t.name}</TableCell>
                    <TableCell sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.65)', maxWidth: 380 }}>
                      <Typography sx={{ fontSize: '0.78rem', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {t.body}
                      </Typography>
                      {t.rejected_reason && t.status === 'REJECTED' && (
                        <Typography sx={{ fontSize: '0.68rem', color: '#EF5350', mt: 0.3 }}>Motivo: {t.rejected_reason}</Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.74rem', color: 'rgba(255,255,255,0.5)' }}>{t.category}</TableCell>
                    <TableCell sx={{ fontSize: '0.74rem', fontFamily: '"JetBrains Mono", monospace' }}>{t.language}</TableCell>
                    <TableCell>
                      <Chip size="small" label={st.label} sx={{ height: 21, fontSize: '0.68rem', fontWeight: 700, backgroundColor: st.bg, color: st.fg }} />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Tooltip title={t.status === 'PENDING' ? 'No editable en revisión' : 'Editar (vuelve a revisión)'}>
                        <span><IconButton size="small" onClick={() => openEdit(t)} disabled={t.status === 'PENDING'}><EditIcon sx={{ fontSize: 15 }} /></IconButton></span>
                      </Tooltip>
                      <Tooltip title="Eliminar">
                        <IconButton size="small" onClick={() => remove(t)}><DeleteIcon sx={{ fontSize: 15, color: 'rgba(239,83,80,0.6)' }} /></IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
      )}

      {/* Dialog crear / editar */}
      <Dialog open={!!target} onClose={() => !saving && setTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Sora", sans-serif', fontWeight: 700 }}>
          {target === 'new' ? 'Crear template de WhatsApp' : `Editar: ${fName}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1.5}>
              <TextField size="small" fullWidth label="Nombre" value={fName}
                onChange={e => setFName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                disabled={target !== 'new'}
                helperText={target === 'new' ? 'minúsculas y guión bajo, ej: reenganche_ventas' : 'El nombre no se puede cambiar'} />
              <FormControl size="small" sx={{ minWidth: 150 }} disabled={target !== 'new'}>
                <InputLabel>Categoría</InputLabel>
                <Select value={fCategory} label="Categoría" onChange={e => setFCategory(e.target.value)}>
                  <MenuItem value="MARKETING">Marketing</MenuItem>
                  <MenuItem value="UTILITY">Utilidad</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 110 }} disabled={target !== 'new'}>
                <InputLabel>Idioma</InputLabel>
                <Select value={fLanguage} label="Idioma" onChange={e => setFLanguage(e.target.value)}>
                  <MenuItem value="es_AR">es_AR</MenuItem>
                  <MenuItem value="es">es</MenuItem>
                  <MenuItem value="en_US">en_US</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <TextField
              size="small" fullWidth multiline minRows={4}
              label="Cuerpo del mensaje"
              value={fBody}
              onChange={e => onBodyChange(e.target.value)}
              helperText={'Usá {{1}}, {{2}}... como variables. Ej: "Hola {{1}}! Tenemos novedades sobre {{2}}."'}
            />
            {fExamples.map((ex, i) => (
              <TextField key={i} size="small" fullWidth
                label={`Ejemplo para {{${i + 1}}}`}
                value={ex}
                onChange={e => setFExamples(prev => prev.map((p, j) => (j === i ? e.target.value : p)))}
                helperText={i === 0 ? 'Meta usa los ejemplos para aprobar el template' : undefined}
              />
            ))}
            <TextField size="small" fullWidth label="Pie (opcional)" value={fFooter} onChange={e => setFFooter(e.target.value)} />
            {target !== 'new' && (
              <Alert severity="info" sx={{ fontSize: '0.78rem', py: 0 }}>
                Al guardar, Meta vuelve a revisar el template (queda "En revisión" hasta aprobarse).
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTarget(null)} disabled={saving}>Cancelar</Button>
          <Button variant="contained" onClick={save} disabled={saving || !fBody.trim() || (target === 'new' && !fName.trim())}>
            {saving ? <CircularProgress size={18} /> : target === 'new' ? 'Crear y enviar a revisión' : 'Guardar'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Templates;
