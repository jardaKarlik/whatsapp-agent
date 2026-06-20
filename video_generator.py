# video_generator.py

import librosa
import numpy as np
import soundfile as sf
import pyglet
# It seems that directly importing all GL functions with `from pyglet.gl import *`
# and `from pyglet.glu import *` still causes `NameError` for some functions.
# This indicates that some functions might be wrapped differently or require a specific context.
# Let\"s try explicitly importing the GL and GLU functions that are causing issues.

from pyglet.gl import (
    glClearColor, glEnable, glMatrixMode, glLoadIdentity, GL_DEPTH_TEST, 
    GL_PROJECTION, GL_MODELVIEW, GL_COLOR_BUFFER_BIT, GL_DEPTH_BUFFER_BIT, 
    GL_QUADS, GL_RGBA, GL_UNSIGNED_BYTE, GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, 
    GL_LINEAR, GL_TEXTURE_MAG_FILTER, GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, 
    GL_DEPTH_COMPONENT, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, GL_FRAMEBUFFER_COMPLETE,
    GL_FRONT, glClear, glGenFramebuffers, glBindFramebuffer, glGenTextures, 
    glBindTexture, glTexImage2D, glTexParameteri, glFramebufferTexture2D, 
    glGenRenderbuffers, glBindRenderbuffer, glRenderbufferStorage, 
    glFramebufferRenderbuffer, glCheckFramebufferStatus, glReadPixels, 
    glViewport, glBegin, glEnd, glColor3f, glVertex3f, glPushMatrix, 
    glTranslatef, glRotatef, glPopMatrix, GLuint # Added GLuint explicitly
)

# gluPerspective is part of GLU, which is separate but often grouped.
# If it still causes issues, we might need a different perspective setup.
# from pyglet.glu import gluPerspective # Commented out the problematic import

from PIL import Image, ImageDraw, ImageFont
import cv2
import subprocess
import os

# --- Configuration --- 
AUDIO_FILE = "C:/_dev/whatsapp-agent/sample.mp3"  # User provided DJ mix
OUTPUT_VIDEO_FILE = "output_djmix_video.mp4"
TEMP_VIDEO_FILE = "temp_video_no_audio.mp4"
VIDEO_WIDTH, VIDEO_HEIGHT = 1280, 720
FPS = 30

# Text Overlays
MIX_TITLE = "MayMiX DjSET"
AUTHOR_NAME = "@djlee_cz"
SOCIAL_IDS = ["instagram.com/djlee_cz", "facebook.com/djlee.cz"]

# --- Audio Analysis --- 
def analyze_audio(audio_path):
    y, sr = librosa.load(audio_path)
    duration = librosa.get_duration(y=y, sr=sr)
    
    # Beat tracking
    onset_env = librosa.onset.onset_detect(y=y, sr=sr)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr) # Corrected beat_track usage
    
    # Energy (RMS) calculation
    rms = librosa.feature.rms(y=y)
    
    # Interpolate features to match video frame rate
    num_frames = int(duration * FPS)
    times = np.linspace(0, duration, num_frames)
    
    # Interpolate RMS energy
    rms_times = librosa.frames_to_time(np.arange(len(rms[0])), sr=sr)
    energy_interp = np.interp(times, rms_times, rms[0])
    energy_interp = (energy_interp - energy_interp.min()) / (energy_interp.max() - energy_interp.min()) # Normalize
    
    # Convert beat events (from beat_track) to a frame-based array
    beat_frames_indices = np.array(beats * (num_frames / len(beats))).astype(int)
    
    beat_strength_per_frame = np.zeros(num_frames)
    for frame_idx in beat_frames_indices:
        if 0 <= frame_idx < num_frames:
            beat_strength_per_frame[frame_idx] = 1.0 # Mark beat frames

    return {"duration": duration, "energy": energy_interp, "beats": beat_strength_per_frame}

# --- Visual Generation (Pyglet for Headless OpenGL) --- 

# Pyglet context and framebuffer objects for off-screen rendering
window = None
fbo_id = GLuint()
texture_id = GLuint()

def setup_offscreen_pyglet():
    global window, fbo_id, texture_id
    
    # Create a dummy window for context, but it will be hidden
    window = pyglet.window.Window(width=VIDEO_WIDTH, height=VIDEO_HEIGHT, visible=False, resizable=False)
    window.switch_to()
    
    # Setup OpenGL for rendering
    glClearColor(0.0, 0.0, 0.0, 1.0)
    glEnable(GL_DEPTH_TEST)
    glMatrixMode(GL_PROJECTION)
    glLoadIdentity()
    gluPerspective(60, VIDEO_WIDTH / VIDEO_HEIGHT, 0.1, 100.0)
    glMatrixMode(GL_MODELVIEW)
    glLoadIdentity()

    # Create an FBO
    glGenFramebuffers(1, fbo_id)
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_id)

    # Create a texture to render into
    glGenTextures(1, texture_id)
    glBindTexture(GL_TEXTURE_2D, texture_id)
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, VIDEO_WIDTH, VIDEO_HEIGHT, 0, GL_RGBA, GL_UNSIGNED_BYTE, None)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR)
    
    # Attach the texture to the FBO
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture_id, 0)
    
    # Create a renderbuffer for depth test
    depth_rbo = GLuint()
    glGenRenderbuffers(1, depth_rbo)
    glBindRenderbuffer(GL_RENDERBUFFER, depth_rbo)
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT, VIDEO_WIDTH, VIDEO_HEIGHT)
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth_rbo)

    # Check FBO completeness
    if glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE:
        print("Error: FBO is not complete!")

    glBindFramebuffer(GL_FRAMEBUFFER, 0) # Bind default framebuffer

animation_frame = 0

def draw_fractal(energy_level):
    glBegin(GL_QUADS)
    for i in range(10):
        r = i * 0.1 * (1 + energy_level * 0.5)
        g = (10 - i) * 0.1 * (1 + energy_level * 0.5)
        b = 0.5 + 0.5 * np.sin(animation_frame * 0.1 + i)
        glColor3f(r, g, b)
        
        angle = animation_frame * 0.01 + i * 0.5
        x1 = np.cos(angle) * (1 + energy_level * 0.2)
        y1 = np.sin(angle) * (1 + energy_level * 0.2)
        x2 = np.cos(angle + np.pi/2) * (1 + energy_level * 0.2)
        y2 = np.sin(angle + np.pi/2) * (1 + energy_level * 0.2)
        
        glVertex3f(x1, y1, -5.0)
        glVertex3f(x2, y2, -5.0)
        glVertex3f(x2 + 0.5, y2 + 0.5, -5.0)
        glVertex3f(x1 + 0.5, y1 + 0.5, -5.0)
    glEnd()

def draw_3d_object(beat_strength):
    glPushMatrix()
    glTranslatef(0.0, 0.0, -7.0)
    glRotatef(animation_frame * 0.5 + beat_strength * 100, 1.0, 1.0, 0.0)
    
    # Draw a cube and sphere using Pyglet\"s graphics primitives if available,
    # or direct GL calls with vertex data.
    # For simplicity, using raw GL calls for cube. Pyglet has more advanced ways
    # for drawing shapes, but this keeps it closer to the original idea.
    
    # Cube
    glColor3f(1.0, 0.5, 0.0) # Orange cube
    pyglet.graphics.draw(24, GL_QUADS,   # 24 vertices for a cube
        ("v3f", (
            # Front face
            1.0,  1.0,  1.0,  -1.0,  1.0,  1.0,  -1.0, -1.0,  1.0,   1.0, -1.0,  1.0,
            # Back face
            1.0,  1.0, -1.0,  -1.0,  1.0, -1.0,  -1.0, -1.0, -1.0,   1.0, -1.0, -1.0,
            # Top face
            1.0,  1.0,  1.0,   1.0,  1.0, -1.0,  -1.0,  1.0, -1.0,  -1.0,  1.0,  1.0,
            # Bottom face
            1.0, -1.0,  1.0,   1.0, -1.0, -1.0,  -1.0, -1.0, -1.0,  -1.0, -1.0,  1.0,
            # Right face
            1.0,  1.0,  1.0,   1.0,  1.0, -1.0,   1.0, -1.0, -1.0,   1.0, -1.0,  1.0,
            # Left face
            -1.0,  1.0,  1.0,  -1.0,  1.0, -1.0,  -1.0, -1.0, -1.0,  -1.0, -1.0,  1.0
        ))
    )
    
    # Sphere - color changes with beat_strength
    glColor3f(0.5 + beat_strength * 0.5, 0.5, 1.0 - beat_strength * 0.5)
    # Pyglet doesn\"t have glutSolidSphere directly. We can simulate it with a batch or mesh.
    # For a simple representation, let\"s draw a circle using GL_TRIANGLE_FAN for now.
    # In a real app, you\"d use a more complex sphere generation algorithm or load a model.
    num_segments = 20
    radius = 0.7
    glBegin(GL_TRIANGLE_FAN)
    glVertex3f(0.0, 0.0, 0.0) # Center of the sphere (relative to current matrix)
    for i in range(num_segments + 1):
        angle = i * 2.0 * np.pi / num_segments
        x = radius * np.cos(angle)
        y = radius * np.sin(angle)
        glVertex3f(x, y, 0.0)
    glEnd()
    
    glPopMatrix()

def draw_scene(energy_level, beat_strength):
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)
    glLoadIdentity()
    
    draw_fractal(energy_level)
    draw_3d_object(beat_strength)
    
    global animation_frame
    animation_frame += 1

def get_pyglet_frame(energy_level, beat_strength):
    # Bind our FBO for rendering
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_id)
    glViewport(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT)

    draw_scene(energy_level, beat_strength)
    
    # Read pixels from the FBO texture
    glBindTexture(GL_TEXTURE_2D, texture_id)
    pixels = glReadPixels(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT, GL_RGBA, GL_UNSIGNED_BYTE)
    
    # Unbind FBO and reset viewport
    glBindFramebuffer(GL_FRAMEBUFFER, 0)
    # Note: We don\"t have a visible window, so resetting viewport to window.width/height is not strictly necessary.
    # However, for consistency or if a tiny window is created, it\"s good practice.
    # glViewport(0, 0, window.width, window.height)

    image = Image.frombytes("RGBA", (VIDEO_WIDTH, VIDEO_HEIGHT), pixels)
    image = image.transpose(Image.FLIP_TOP_BOTTOM)
    
    return image.convert("RGB") 

# --- Text Overlay --- 
def add_text_overlays(frame_image, current_time, audio_duration):
    draw = ImageDraw.Draw(frame_image)
    
    try:
        font_large = ImageFont.truetype("arial.ttf", 40)
        font_small = ImageFont.truetype("arial.ttf", 20)
    except IOError:
        font_large = ImageFont.load_default()
        font_small = ImageFont.load_default()
        print("Could not load arial.ttf, using default font.")

    draw.text((50, 50), MIX_TITLE, font=font_large, fill=(255, 255, 255))
    draw.text((50, 100), AUTHOR_NAME, font=font_small, fill=(200, 200, 200))
    
    footer_text = " | ".join(SOCIAL_IDS)
    text_width, text_height = draw.textbbox((0,0), footer_text, font=font_small)[2:]
    draw.text(((VIDEO_WIDTH - text_width) / 2, VIDEO_HEIGHT - 50), footer_text, font=font_small, fill=(150, 150, 150))
    
    progress_bar_width = int((current_time / audio_duration) * VIDEO_WIDTH)
    draw.rectangle([0, VIDEO_HEIGHT - 10, progress_bar_width, VIDEO_HEIGHT], fill=(255, 0, 0))
    
    return frame_image

# --- Main Video Generation Loop --- 
def generate_video():
    global audio_data
    
    print(f"Analyzing audio file: {AUDIO_FILE}...")
    audio_data = analyze_audio(AUDIO_FILE)
    DURATION = audio_data["duration"]
    print(f"Audio duration: {DURATION:.2f} seconds")
    
    total_frames = int(DURATION * FPS)
    print(f"Generating {total_frames} frames...")
    
    # Setup off-screen Pyglet context and FBO
    setup_offscreen_pyglet()
    
    # OpenCV VideoWriter for raw video frames (no audio yet)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v") 
    out = cv2.VideoWriter(TEMP_VIDEO_FILE, fourcc, FPS, (VIDEO_WIDTH, VIDEO_HEIGHT))
    
    if not out.isOpened():
        print(f"Error: Could not open video writer for {TEMP_VIDEO_FILE}")
        return
        
    print("Starting video frame generation...")
    for i in range(total_frames):
        current_time = i / FPS
        energy_level = audio_data["energy"][i] if i < len(audio_data["energy"]) else 0.0
        beat_strength = audio_data["beats"][i] if i < len(audio_data["beats"]) else 0.0
        
        gl_frame_image = get_pyglet_frame(energy_level, beat_strength)
        final_frame = add_text_overlays(gl_frame_image, current_time, DURATION)
        
        opencv_frame = np.array(final_frame)
        opencv_frame = cv2.cvtColor(opencv_frame, cv2.COLOR_RGB2BGR)
        
        out.write(opencv_frame)
        
        if i % (FPS * 10) == 0: 
            print(f"Progress: {current_time:.2f}/{DURATION:.2f} seconds ({(current_time/DURATION)*100:.1f}%) -- Frame {i}/{total_frames}")

    out.release()
    # Close Pyglet window/context cleanly
    if window:
        window.close()

    print(f"Temporary video (no audio) generation complete: {TEMP_VIDEO_FILE}")
    
    # --- Merge video with audio using FFmpeg --- 
    print(f"Merging {TEMP_VIDEO_FILE} with {AUDIO_FILE} into {OUTPUT_VIDEO_FILE} using FFmpeg...")
    ffmpeg_cmd = [
        "ffmpeg",
        "-y",
        "-i", TEMP_VIDEO_FILE,
        "-i", AUDIO_FILE,
        "-c:v", "copy",
        "-c:a", "aac", # Re-encode audio to AAC for broad compatibility
        "-strict", "experimental", # Needed for some AAC encodings
        "-map", "0:v:0", # Map video stream from first input
        "-map", "1:a:0", # Map audio stream from second input
        OUTPUT_VIDEO_FILE
    ]
    
    try:
        subprocess.run(ffmpeg_cmd, check=True, capture_output=True)
        print("FFmpeg merge successful.")
        # Clean up temporary video file
        os.remove(TEMP_VIDEO_FILE)
        print(f"Cleaned up temporary file: {TEMP_VIDEO_FILE}")
    except subprocess.CalledProcessError as e:
        print(f"FFmpeg command failed with error: {e}")
        print(f"Stdout: {e.stdout.decode()}")
        print(f"Stderr: {e.stderr.decode()}")
    except FileNotFoundError:
        print("Error: FFmpeg not found. Please ensure FFmpeg is installed and in your PATH.")

if __name__ == "__main__":
    # For local testing, ensure sample.mp3 exists or create a dummy audio file.
    if not os.path.exists(AUDIO_FILE):
        print(f"Warning: Audio file {AUDIO_FILE} not found. Creating a dummy WAV for testing.")
        samplerate = 44100  # samples per second
        duration = 30  # seconds
        frequency = 440  # Hz
        t = np.linspace(0., duration, int(samplerate * duration), endpoint=False)
        amplitude = np.iinfo(np.int16).max * 0.5
        data = amplitude * np.sin(2. * np.pi * frequency * t)
        sf.write(AUDIO_FILE.replace(".mp3", ".wav"), data.astype(np.int16), samplerate)
        # Update AUDIO_FILE to point to the dummy WAV for testing
        AUDIO_FILE = AUDIO_FILE.replace(".mp3", ".wav")
        print(f"Created dummy audio file: {AUDIO_FILE}")
    
    # Removed automatic call to generate_video() here to prevent accidental runs.
    # Call generate_video() explicitly when ready.

</final_file_content>

IMPORTANT: For any future changes to this file, use the final_file_content shown above as your reference. This content reflects the current state of the file, including any auto-formatting (e.g., if you used single quotes but the formatter converted them to double quotes). Always base your SEARCH/REPLACE operations on this final version to ensure accuracy.


