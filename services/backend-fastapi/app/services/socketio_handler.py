"""
Socket.IO events handler for real-time communication
"""
import socketio
from fastapi import APIRouter

# Create Socket.IO server
sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins="*",
    ping_timeout=60,
    ping_interval=25
)

# Create ASGI app wrapper
sio_app = socketio.ASGIApp(sio)

# Store connected sessions
connected_sessions = {}

@sio.event
async def connect(sid, environ, auth=None):
    """Handle client connection"""
    print(f"Client connected: {sid}, auth: {auth}")
    connected_sessions[sid] = {
        'sid': sid,
        'auth': auth,
        'connected_at': __import__('datetime').datetime.now()
    }
    
    # Send welcome message
    await sio.emit('connect_response', {
        'status': 'connected',
        'sid': sid
    }, room=sid)

@sio.event
async def disconnect(sid):
    """Handle client disconnection"""
    print(f"Client disconnected: {sid}")
    if sid in connected_sessions:
        del connected_sessions[sid]

@sio.event
async def message(sid, data):
    """Handle incoming messages from client"""
    print(f"Message from {sid}: {data}")
    await sio.emit('message_response', {
        'status': 'received',
        'data': data
    }, room=sid)

@sio.event
async def join_room(sid, room):
    """Join a room (e.g., conversation room)"""
    print(f"Client {sid} joining room: {room}")
    await sio.enter_room(sid, room)

@sio.event
async def leave_room(sid, room):
    """Leave a room"""
    print(f"Client {sid} leaving room: {room}")
    await sio.leave_room(sid, room)

# Utility functions to emit events from other parts of the app
async def emit_to_room(room: str, event: str, data: dict):
    """Emit event to all clients in a room"""
    await sio.emit(event, data, room=room)

async def emit_to_all(event: str, data: dict):
    """Emit event to all connected clients"""
    await sio.emit(event, data)

async def emit_to_user(sid: str, event: str, data: dict):
    """Emit event to a specific user"""
    await sio.emit(event, data, room=sid)
