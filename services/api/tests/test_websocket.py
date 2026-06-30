import asyncio
import websockets
import json
import base64

async def test_realtime_pipeline():
    url = "ws://localhost:8012/ws/audio?stt_provider=mock&translation_provider=mock"
    print(f"Connecting to {url}...")
    
    try:
        async with websockets.connect(url) as websocket:
            print("Connected successfully!")
            
            # Start a task to receive messages from the server
            async def receive_messages():
                try:
                    async for message in websocket:
                        data = json.loads(message)
                        msg_type = data.get("type")
                        if msg_type == "transcript.partial":
                            print(f"[PARTIAL] STT: {data.get('text')} (stability: {data.get('stability')})")
                        elif msg_type == "transcript.final":
                            print(f"\n[FINAL] STT: {data.get('text')}")
                        elif msg_type == "translation.final":
                            print(f"[TRANSLATION] {data.get('translated_text')}\n")
                except websockets.exceptions.ConnectionClosed:
                    print("Connection closed by server.")
                except Exception as e:
                    print(f"Error receiving: {e}")

            recv_task = asyncio.create_task(receive_messages())
            
            # Send simulated audio chunks
            print("Sending simulated audio chunks...")
            for i in range(12):  # Send chunks for a few seconds
                dummy_chunk = b"\x00" * 3200  # 100ms chunk
                b64_data = base64.b64encode(dummy_chunk).decode("utf-8")
                
                await websocket.send(json.dumps({
                    "type": "audio.chunk",
                    "audio_base64": b64_data
                }))
                
                await asyncio.sleep(0.3)  # Send every 300ms
                
            # Send stop command
            print("Sending audio.stop command...")
            await websocket.send(json.dumps({
                "type": "audio.stop"
            }))
            
            # Wait for receive loop to process final translation
            await asyncio.sleep(2.0)
            recv_task.cancel()
            
    except Exception as e:
        print(f"WebSocket test failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_realtime_pipeline())
