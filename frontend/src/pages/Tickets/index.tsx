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
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Stack,
  CircularProgress,
  MenuItem,
  FormControl,
  InputLabel,
  Select
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../../services/api';

const ackLabel = (ack?: number) => {
  if (ack === undefined || ack === null) return 'pendiente';
  if (ack >= 3) return 'leído';
  if (ack >= 1) return 'entregado';
  return 'enviado';
};

const Tickets = () => {
  const location = useLocation();
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [users, setUsers] = useState<any[]>([]);
  const [queues, setQueues] = useState<any[]>([]);

  const [open, setOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');

  const [updatingTicket, setUpdatingTicket] = useState(false);

  const fetchTickets = async () => {
    const { data } = await api.get('/conversations');
    setTickets(data);
    if (queryTicketId && Array.isArray(data)) {
      const t = data.find((x: any) => x.id === queryTicketId);
      if (t) await handleOpenTicket(t);
    }
  };

  const fetchUsersQueues = async () => {
    try {
      const [{ data: u }, { data: q }] = await Promise.all([api.get('/users'), api.get('/queues')]);
      setUsers(Array.isArray(u) ? u : []);
      setQueues(Array.isArray(q) ? q : []);
    } catch (e) {
      console.error('Error fetching users/queues:', e);
    }
  };

  const queryTicketId = (() => {
    try {
      const sp = new URLSearchParams(location.search);
      const v = sp.get('ticketId');
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([fetchTickets(), fetchUsersQueues()]);
      } catch (error) {
        console.error('Error fetching tickets:', error);
        toast.error('Error al cargar tickets');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!open || !selectedTicket?.id) return;

    const timer = setInterval(async () => {
      try {
        await Promise.all([fetchMessages(selectedTicket.id), fetchTickets()]);
      } catch {}
    }, 5000);

    return () => clearInterval(timer);
  }, [open, selectedTicket?.id]);

  const fetchMessages = async (ticketId: number) => {
    setLoadingMessages(true);
    try {
      const { data } = await api.get(`/messages/${ticketId}`);
      setMessages(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching messages:', error);
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleOpenTicket = async (ticket: any) => {
    setSelectedTicket(ticket);
    setText('');
    setOpen(true);
    await fetchMessages(ticket.id);
  };

  const handleClose = () => {
    setOpen(false);
    setSelectedTicket(null);
    setMessages([]);
    setText('');
  };

  const handleSend = async () => {
    if (!selectedTicket?.id) return;
    if (!text.trim()) return;

    setSending(true);
    try {
      await api.post('/messages', { ticketId: selectedTicket.id, body: text.trim() });
      setText('');
      await fetchMessages(selectedTicket.id);
      await fetchTickets();
    } catch (error: any) {
      console.error('Error sending message:', error);
      toast.error(error?.response?.data?.error || 'Error al enviar mensaje');
    } finally {
      setSending(false);
    }
  };

  const updateTicket = async (patch: any) => {
    if (!selectedTicket?.id) return;
    setUpdatingTicket(true);
    try {
      const { data } = await api.put(`/conversations/${selectedTicket.id}`, patch);
      setSelectedTicket((prev: any) => ({ ...prev, ...data }));
      await fetchTickets();
      toast.success('Ticket actualizado');
    } catch (error: any) {
      console.error('Error updating ticket:', error);
      toast.error(error?.response?.data?.error || 'Error al actualizar ticket');
    } finally {
      setUpdatingTicket(false);
    }
  };

  const statusColor = useMemo(() => {
    return (status: string) => {
      switch (status) {
        case 'open':
          return 'success';
        case 'pending':
          return 'warning';
        case 'closed':
          return 'default';
        default:
          return 'default';
      }
    };
  }, []);

  const filteredTickets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((ticket: any) => {
      const name = String(ticket.contact?.name || '').toLowerCase();
      const id = String(ticket.id || '');
      const status = String(ticket.status || '').toLowerCase();
      return name.includes(q) || id.includes(q) || status.includes(q);
    });
  }, [tickets, search]);

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Tickets
      </Typography>

      <TextField
        size="small"
        label="Buscar por contacto, ID o estado"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ minWidth: 320, mb: 2 }}
      />

      <Paper sx={{ mt: 1 }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Contacto</TableCell>
                <TableCell>Estado</TableCell>
                <TableCell>No leídos</TableCell>
                <TableCell>Usuario</TableCell>
                <TableCell>Cola</TableCell>
                <TableCell>Última Actualización</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    Cargando...
                  </TableCell>
                </TableRow>
              ) : filteredTickets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    No hay tickets disponibles
                  </TableCell>
                </TableRow>
              ) : (
                filteredTickets.map((ticket: any) => (
                  <TableRow
                    key={ticket.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => handleOpenTicket(ticket)}
                  >
                    <TableCell>{ticket.id}</TableCell>
                    <TableCell>{ticket.contact?.name || 'N/A'}</TableCell>
                    <TableCell>
                      <Chip label={ticket.status} color={statusColor(ticket.status)} size="small" />
                    </TableCell>
                    <TableCell>
                      {!!ticket.unreadMessages && ticket.unreadMessages > 0 ? (
                        <Chip label={ticket.unreadMessages} color="error" size="small" />
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>{ticket.user?.name || 'Sin asignar'}</TableCell>
                    <TableCell>{ticket.queue?.name || 'Sin cola'}</TableCell>
                    <TableCell>{new Date(ticket.updatedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md">
        <DialogTitle>
          Ticket #{selectedTicket?.id} — {selectedTicket?.contact?.name || 'Contacto'}
        </DialogTitle>
        <DialogContent dividers>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Estado</InputLabel>
              <Select
                label="Estado"
                value={selectedTicket?.status || 'pending'}
                disabled={updatingTicket}
                onChange={(e) => updateTicket({ status: e.target.value })}
              >
                <MenuItem value="pending">pending</MenuItem>
                <MenuItem value="open">open</MenuItem>
                <MenuItem value="closed">closed</MenuItem>
              </Select>
            </FormControl>

            <FormControl fullWidth size="small">
              <InputLabel>Usuario</InputLabel>
              <Select
                label="Usuario"
                value={selectedTicket?.userId ?? ''}
                disabled={updatingTicket}
                onChange={(e) =>
                  updateTicket({ userId: e.target.value === '' ? null : Number(e.target.value) })
                }
              >
                <MenuItem value="">Sin asignar</MenuItem>
                {users.map((u) => (
                  <MenuItem key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl fullWidth size="small">
              <InputLabel>Cola</InputLabel>
              <Select
                label="Cola"
                value={selectedTicket?.queueId ?? ''}
                disabled={updatingTicket}
                onChange={(e) =>
                  updateTicket({ queueId: e.target.value === '' ? null : Number(e.target.value) })
                }
              >
                <MenuItem value="">Sin cola</MenuItem>
                {queues.map((q) => (
                  <MenuItem key={q.id} value={q.id}>
                    {q.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          {loadingMessages ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress />
            </Box>
          ) : messages.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No hay mensajes aún.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {messages.map((m: any) => (
                <Paper key={m.id || `${m.createdAt}-${m.body}`} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction="row" justifyContent="space-between" spacing={2}>
                    <Typography variant="caption" sx={{ opacity: 0.8 }}>
                      {m.fromMe ? 'Agente' : selectedTicket?.contact?.name || 'Cliente'}
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      {m.fromMe && (
                        <Chip size="small" variant="outlined" label={ackLabel(m.ack)} />
                      )}
                      <Typography variant="caption" sx={{ opacity: 0.7 }}>
                        {m.createdAt ? new Date(m.createdAt).toLocaleString() : ''}
                      </Typography>
                    </Stack>
                  </Stack>
                  <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                    {m.body}
                  </Typography>
                </Paper>
              ))}
            </Stack>
          )}

          <Box sx={{ mt: 2 }}>
            <TextField
              fullWidth
              multiline
              minRows={2}
              label="Escribir mensaje"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              helperText="Enter para enviar · Shift+Enter para salto de línea"
              disabled={sending}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cerrar</Button>
          <Button variant="contained" onClick={handleSend} disabled={sending || !text.trim()}>
            {sending ? 'Enviando…' : 'Enviar'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Tickets;
