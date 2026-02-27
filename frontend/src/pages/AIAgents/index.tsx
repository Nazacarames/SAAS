import { useEffect, useMemo, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Stack,
  TextField,
  Button,
  Divider,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Chip,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const AIAgents = () => {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('Asistente Charlott');
  const [persona, setPersona] = useState('Respondé claro y breve. Priorizá resolver dudas comerciales y pedir datos clave cuando falte contexto.');
  const [welcomeMsg, setWelcomeMsg] = useState('¡Hola! Soy el asistente de Charlott. ¿En qué te ayudo hoy?');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);

  const [searchQuery, setSearchQuery] = useState('precio');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const fetchAgents = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/ai/agents');
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      toast.error('No se pudo cargar Agente IA');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const activeAgent = useMemo(() => agents.find((a) => a.is_active) || agents[0], [agents]);

  const resetForm = () => {
    setEditingId(null);
    setName('Asistente Charlott');
    setPersona('Respondé claro y breve. Priorizá resolver dudas comerciales y pedir datos clave cuando falte contexto.');
    setWelcomeMsg('¡Hola! Soy el asistente de Charlott. ¿En qué te ayudo hoy?');
  };

  const createOrUpdateAgent = async () => {
    try {
      if (editingId) {
        await api.put(`/ai/agents/${editingId}`, {
          name,
          persona,
          language: 'es',
          model: 'gpt-4o-mini',
          welcomeMsg
        });
        toast.success('Agente IA actualizado');
      } else {
        await api.post('/ai/agents', {
          name,
          persona,
          language: 'es',
          model: 'gpt-4o-mini',
          welcomeMsg,
          isActive: true
        });
        toast.success('Agente IA guardado');
      }
      resetForm();
      fetchAgents();
    } catch {
      toast.error(editingId ? 'No se pudo actualizar Agente IA' : 'No se pudo guardar Agente IA');
    }
  };

  const editAgent = (agent: any) => {
    setEditingId(agent.id);
    setName(agent.name || '');
    setPersona(agent.persona || '');
    setWelcomeMsg(agent.welcome_msg || '');
  };

  const toggleAgent = async (agent: any) => {
    try {
      await api.put(`/ai/agents/${agent.id}`, { isActive: !agent.is_active });
      toast.success('Estado actualizado');
      fetchAgents();
    } catch {
      toast.error('No se pudo actualizar estado');
    }
  };

  const deleteAgent = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/ai/agents/${deleteTarget.id}`);
      toast.success('Agente eliminado');
      setDeleteTarget(null);
      if (editingId === deleteTarget.id) resetForm();
      fetchAgents();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'No se pudo eliminar');
    }
  };

  const searchKb = async () => {
    try {
      const { data } = await api.post('/ai/rag/search', { query: searchQuery, limit: 5 });
      setSearchResults(Array.isArray(data) ? data : []);
    } catch {
      toast.error('No se pudo buscar en conocimiento');
    }
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>
        Agente IA
      </Typography>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Configurá el comportamiento del asistente. El modelo se optimiza automáticamente para respuestas rápidas y precisas.
      </Typography>

      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Paper sx={{ p: 2 }}>
            <Typography variant='h6'>{editingId ? `Editando agente #${editingId}` : 'Configuración principal'}</Typography>
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              <TextField label='Nombre del asistente' value={name} onChange={(e) => setName(e.target.value)} />
              <TextField label='Mensaje de bienvenida' value={welcomeMsg} onChange={(e) => setWelcomeMsg(e.target.value)} multiline minRows={2} />
              <TextField
                label='Instrucciones del asistente'
                helperText='Definí tono, objetivo y cómo responder.'
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                multiline
                minRows={4}
              />
              <Stack direction='row' spacing={1}>
                <Button variant='contained' onClick={createOrUpdateAgent}>
                  {editingId ? 'Guardar cambios' : 'Guardar asistente'}
                </Button>
                {editingId && (
                  <Button variant='outlined' onClick={resetForm}>
                    Cancelar edición
                  </Button>
                )}
              </Stack>
            </Stack>
          </Paper>
        </Grid>

        <Grid item xs={12} md={7}>
          <Paper sx={{ p: 2, mb: 2 }}>
            <Typography variant='h6'>Estado del Agente IA</Typography>
            {activeAgent ? (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Typography variant='body2'>
                  <strong>Activo:</strong> {activeAgent.name}
                </Typography>
                <Typography variant='body2'>
                  <strong>Instrucciones:</strong> {activeAgent.persona}
                </Typography>
                <Stack direction='row' spacing={1}>
                  <Button size='small' variant='outlined' onClick={() => editAgent(activeAgent)}>
                    Editar
                  </Button>
                  <Button size='small' onClick={() => toggleAgent(activeAgent)}>
                    {activeAgent.is_active ? 'Desactivar' : 'Activar'}
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Typography sx={{ mt: 1 }}>Todavía no hay agentes creados.</Typography>
            )}
          </Paper>

          <Paper sx={{ p: 2 }}>
            <Typography variant='h6'>Búsqueda inteligente en Conocimiento</Typography>
            <Stack direction='row' spacing={1.5} sx={{ mt: 1 }}>
              <TextField fullWidth label='Probá una pregunta real del cliente' value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
              <Button variant='outlined' onClick={searchKb}>
                Buscar
              </Button>
            </Stack>
            <Divider sx={{ my: 2 }} />
            <Stack spacing={1}>
              {searchResults.length === 0 ? (
                <Typography variant='body2' color='text.secondary'>
                  Sin resultados aún.
                </Typography>
              ) : (
                searchResults.map((r, idx) => (
                  <Paper key={idx} variant='outlined' sx={{ p: 1.25 }}>
                    <Typography variant='caption'>
                      {r.title} · {r.category} · relevancia {Number(r.score || r.similarity || 0).toFixed(2)}
                    </Typography>
                    <Typography variant='body2'>{r.chunk_text}</Typography>
                  </Paper>
                ))
              )}
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 2, mt: 2 }}>
        <Typography variant='h6'>Historial de agentes</Typography>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Nombre</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell>Acción</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4}>Cargando...</TableCell>
              </TableRow>
            ) : agents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>Sin agentes</TableCell>
              </TableRow>
            ) : (
              agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.id}</TableCell>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>
                    <Chip size='small' color={a.is_active ? 'success' : 'default'} label={a.is_active ? 'Activo' : 'Inactivo'} />
                  </TableCell>
                  <TableCell>
                    <Stack direction='row' spacing={1}>
                      <Button size='small' variant='outlined' onClick={() => editAgent(a)}>
                        Editar
                      </Button>
                      <Button size='small' onClick={() => toggleAgent(a)}>
                        {a.is_active ? 'Desactivar' : 'Activar'}
                      </Button>
                      <Button size='small' color='error' onClick={() => setDeleteTarget(a)}>
                        Eliminar
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Eliminar agente IA</DialogTitle>
        <DialogContent>
          <Typography variant='body2'>
            ¿Seguro que querés eliminar <strong>{deleteTarget?.name}</strong>? Esta acción no se puede deshacer.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancelar</Button>
          <Button color='error' variant='contained' onClick={deleteAgent}>Eliminar</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AIAgents;
