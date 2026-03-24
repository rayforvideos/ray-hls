# Test Fixtures

Generate a small test video file for integration testing:

```
ffmpeg -f lavfi -i testsrc=duration=12:size=320x240:rate=30 \
       -f lavfi -i sine=frequency=440:duration=12 \
       -c:v libx264 -profile:v baseline -g 90 \
       -c:a aac -b:a 64k \
       test/fixtures/test-video.mp4
```

This creates a 12-second test video with:
- 320x240 resolution, 30fps
- Keyframe every 3 seconds (90 frames)
- AAC audio at 440Hz sine wave
