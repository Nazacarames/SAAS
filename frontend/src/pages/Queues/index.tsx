import { useEffect, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

interface Queue {
  id: number;
  name: string;
  color: string;
  greetingMessage?: string;
}

const Queues = () => {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [greetingMessage, setGreetingMessage] = useState('');

  const fetchQueues = async () => {
    try {
      const { data } = await api.get('/queues');
      setQueues(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching queues:', error);
      toast.error('Error al cargar colas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueues();
  }, []);

  const handleOpen = () => {
    setName('');
    setColor('#3b82f6');
    setGreetingMessage('');
    setOpen(true);
  };

  const handleClose = () => {
    if (!creating) setOpen(false);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error('Ingresá un nombre');
      return;
    }

    setCreating(true);
    try {
      await api.post('/queues', { name, color, greetingMessage });
      toast.success('Cola creada');
      setOpen(false);
      fetchQueues();
    } catch (error: any) {
      console.error('Error creating queue:', error);
      toast.error(error.response?.data?.message || 'Error al crear cola');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4">Colas / Departamentos</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpen}>
          Nueva Cola
        </Button>
      </Box>

      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Nombre</TableCell>
                <TableCell>Color</TableCell>
                <TableCell>Mensaje</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={4} align="center">Cargando...</TableCell></TableRow>
              ) : queues.length === 0 ? (
                <TableRow><TableCell colSpan={4} align="center">No hay colas</TableCell></TableRow>
              ) : (
                queues.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell>{q.id}</TableCell>
                    <TableCell>{q.name}</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: q.color, border: '1px solid #333' }} />
                        {q.color}
                      </Box>
                    </TableCell>
                    <TableCell>{q.greetingMessage || '-'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Nueva Cola</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2, display: 'grid', gap: 2 }}>
            <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} fullWidth disabled={creating} />
            <TextField label="Color" value={color} onChange={(e) => setColor(e.target.value)} fullWidth disabled={creating} />
            <TextField label="Mensaje de saludo" value={greetingMessage} onChange={(e) => setGreetingMessage(e.target.value)} fullWidth multiline minRows={2} disabled={creating} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={creating}>Cancelar</Button>
          <Button onClick={handleCreate} variant="contained" disabled={creating}>Crear</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Queues;
