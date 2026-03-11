import { useEffect, useMemo, useState } from 'react';
import {
  Typography, Box, Paper, Stack, TextField, Button, Grid, Chip, MenuItem, Dialog, DialogTitle, DialogContent, DialogActions
} from '@mui/material';
import { Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const emptyForm = { title: '', category: 'general', content: '' };

const Knowledge = () => {
  const [stats, setStats] = useState({ total: 0, synced: 0, pending: 0, categories: 0 });
  const [openGuide, setOpenGuide] = useState(false);
  const [docs, setDocs] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [openEdit, setOpenEdit] = useState(false);
  const [form, setForm] = useState<any>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const [s, d] = await Promise.all([
        api.get('/ai/kb/stats'),
        api.get('/ai/kb/documents', { params: { q, category: categoryFilter, status: statusFilter } })
      ]);
      setStats(s.data || { total: 0, synced: 0, pending: 0, categories: 0 });
      setDocs(Array.isArray(d.data) ? d.data : []);
    } catch {
      toast.error('No se pudo cargar conocimiento');
    }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditingId(null);
    setForm({ title: 'Información General', category: 'general', content: '' });
    setOpenEdit(true);
  };

  const openExisting = (d: any) => {
    setEditingId(d.id);
    setForm({ title: d.title || '', category: d.category || 'general', content: d.content || '' });
    setOpenEdit(true);
  };

  const saveDoc = async () => {
    if (!form.title?.trim() || !form.content?.trim()) return toast.error('Completá título y contenido');
    try {
      if (editingId) {
        await api.put(`/ai/kb/documents/${editingId}`, form);
        toast.success('Documento actualizado');
      } else {
        await api.post('/ai/kb/documents', form);
        toast.success('Documento creado');
      }
      setOpenEdit(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'No se pudo guardar documento');
    }
  };

  const removeDoc = async (id: number) => {
    if (!window.confirm('¿Eliminar documento? Esta acción no se puede deshacer.')) return;
    try {
      await api.delete(`/ai/kb/documents/${id}`);
      toast.success('Documento eliminado');
      await load();
    } catch {
      toast.error('No se pudo eliminar documento');
    }
  };

  const cards = useMemo(() => [
    { title: 'Total Documentos', value: stats.total },
    { title: 'Sincronizados', value: stats.synced },
    { title: 'Pendientes', value: stats.pending },
    { title: 'Categorías', value: stats.categories }
  ], [stats]);

  return (
    <Box>
      <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
        <Typography variant='h4'>Base de Conocimiento</Typography>
        <Stack direction='row' spacing={1}>
          <Button variant='outlined' onClick={() => setOpenGuide(true)}>Guía</Button>
          <Button variant='contained' startIcon={<AddIcon />} onClick={openNew}>Nuevo</Button>
        </Stack>
      </Stack>

      <Grid container spacing={2} sx={{ mb: 2 }}>{cards.map((c) => (
        <Grid item xs={12} md={3} key={c.title}><Paper sx={{ p: 2 }}><Typography variant='caption'>{c.title}</Typography><Typography variant='h5'>{c.value}</Typography></Paper></Grid>
      ))}</Grid>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction='row' spacing={1.5}>
          <TextField fullWidth placeholder='Buscar…' value={q} onChange={(e) => setQ(e.target.value)} />
          <TextField select label='Categoría' value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} sx={{ minWidth: 170 }}>
            <MenuItem value=''>Todas</MenuItem><MenuItem value='general'>general</MenuItem><MenuItem value='faq'>faq</MenuItem>
          </TextField>
          <TextField select label='Estado' value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value=''>Todos</MenuItem><MenuItem value='ready'>Sincronizado</MenuItem>
          </TextField>
          <Button variant='outlined' onClick={load}>Filtrar</Button>
        </Stack>
      </Paper>

      <Grid container spacing={2}>{docs.map((d: any) => (
        <Grid item xs={12} md={4} key={d.id}>
          <Paper variant='outlined' sx={{ p: 1.5 }}>
            <Stack direction='row' justifyContent='space-between' sx={{ mb: 1 }}>
              <Chip size='small' label={d.category || 'general'} />
              <Typography variant='caption'>{d.status === 'ready' ? 'Sincronizado' : d.status}</Typography>
            </Stack>
            <Typography variant='subtitle2'>{d.title}</Typography>
            <Typography variant='caption' color='text.secondary'>Chunks: {d.chunks}</Typography>
            <Stack direction='row' spacing={1} sx={{ mt: 1 }}>
              <Button size='small' startIcon={<EditIcon />} onClick={() => openExisting(d)}>Editar</Button>
              <Button size='small' color='error' startIcon={<DeleteIcon />} onClick={() => removeDoc(d.id)}>Eliminar</Button>
            </Stack>
          </Paper>
        </Grid>
      ))}</Grid>

      <Dialog open={openEdit} onClose={() => setOpenEdit(false)} maxWidth='sm' fullWidth>
        <DialogTitle>{editingId ? 'Editar documento' : 'Nuevo documento'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField label='Título' value={form.title} onChange={(e) => setForm((f: any) => ({ ...f, title: e.target.value }))} />
            <TextField select label='Categoría' value={form.category} onChange={(e) => setForm((f: any) => ({ ...f, category: e.target.value }))}>
              <MenuItem value='general'>general</MenuItem><MenuItem value='faq'>faq</MenuItem><MenuItem value='precios'>precios</MenuItem><MenuItem value='casos_uso'>casos_uso</MenuItem>
            </TextField>
            <TextField label='Contenido' multiline minRows={7} value={form.content} onChange={(e) => setForm((f: any) => ({ ...f, content: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenEdit(false)}>Cancelar</Button>
          <Button variant='contained' onClick={saveDoc}>Guardar</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={openGuide} onClose={() => setOpenGuide(false)} maxWidth='sm' fullWidth>
        <DialogTitle>Guía rápida de Conocimiento</DialogTitle>
        <DialogContent>
          <Stack spacing={1.2} sx={{ mt: 1 }}>
            <Typography variant='body2'>1) Creá documentos con preguntas/respuestas concretas.</Typography>
            <Typography variant='body2'>2) Usá categorías para separar temas (faq, precios, casos_uso).</Typography>
            <Typography variant='body2'>3) Aplicá filtros y buscador para encontrar y editar rápido.</Typography>
            <Typography variant='body2'>4) Eliminá contenido viejo para evitar respuestas desactualizadas.</Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenGuide(false)}>Cerrar</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Knowledge;
