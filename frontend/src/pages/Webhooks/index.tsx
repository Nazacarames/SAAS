import { useEffect, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Button,
  Stack,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Webhooks = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const [name, setName] = useState('');
  const [event, setEvent] = useState('lead.created');
  const [url, setUrl] = useState('');

  const load = async () => {
    try {
      const { data } = await api.get('/webhooks');
      setRows(Array.isArray(data) ? data : []);
    } catch {
      toast.error('No se pudieron cargar webhooks');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setEvent('lead.created');
    setUrl('');
    setOpen(true);
  };

  const openEdit = (r: any) => {
    setEditing(r);
    setName(r.name || '');
    setEvent(r.event || 'lead.created');
    setUrl(r.url || '');
    setOpen(true);
  };

  const save = async () => {
    try {
      if (editing?.id) await api.put(`/webhooks/${editing.id}`, { name, event, url, active: true });
      else await api.post('/webhooks', { name, event, url, active: true });
      toast.success('Webhook guardado');
      setOpen(false);
      load();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'No se pudo guardar');
    }
  };

  const remove = async (id: number) => {
    try {
      await api.delete(`/webhooks/${id}`);
      toast.success('Webhook eliminado');
      load();
    } catch {
      toast.error('No se pudo eliminar');
    }
  };

  return (
    <Box>
      <Stack direction='row' justifyContent='space-between' sx={{ mb: 2 }}>
        <Typography variant='h4'>Webhooks</Typography>
        <Button variant='contained' onClick={openCreate}>Nuevo</Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Nombre</TableCell>
              <TableCell>Evento</TableCell>
              <TableCell>URL</TableCell>
              <TableCell>Activo</TableCell>
              <TableCell>Acciones</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.id}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell>{r.event}</TableCell>
                <TableCell>{r.url}</TableCell>
                <TableCell>{r.active ? 'Sí' : 'No'}</TableCell>
                <TableCell>
                  <Button size='small' onClick={() => openEdit(r)}>Editar</Button>
                  <Button size='small' color='error' onClick={() => remove(r.id)}>Borrar</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth='sm' fullWidth>
        <DialogTitle>{editing ? 'Editar webhook' : 'Nuevo webhook'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField label='Nombre' value={name} onChange={(e) => setName(e.target.value)} />
            <TextField label='Evento' value={event} onChange={(e) => setEvent(e.target.value)} />
            <TextField label='URL' value={url} onChange={(e) => setUrl(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
          <Button variant='contained' onClick={save}>Guardar</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Webhooks;
