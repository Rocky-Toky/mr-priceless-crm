/* Mr Priceless - flowing gold waves (the boot screen, the sign-in page and the
   Today header). Loaded straight after <body> so the boot screen shows from
   the very first frame, before the CRM itself loads. No libraries.
   window.mpWaves(canvas, { dim }) draws on a canvas and returns { stop, start }.
   window.mpBoot(mode) is called by the CRM once it knows what to show:
   "app" fades the boot screen away; "auth" keeps the waves behind the
   sign-in box. */
(function(){
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Each ribbon is a bundle of thin lines riding two slow sine waves, like light through water.
  var RIBBONS = [
    { y: .58, amp: .10, len: 1.5, speed: .00016, lines: 18, spread: .07, alpha: .55, phase: 0 },
    { y: .64, amp: .07, len: 2.2, speed: -.00011, lines: 12, spread: .05, alpha: .38, phase: 1.7 },
    { y: .50, amp: .13, len: 1.0, speed: .00009, lines: 9, spread: .10, alpha: .26, phase: 3.1 }
  ];
  function mpWaves(cv, o){
    o = o || {};
    var ctx = cv.getContext("2d"), w = 0, h = 0, raf = 0, running = true, last = 0, t0 = performance.now();
    function size(){
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth || cv.parentNode.clientWidth; h = cv.clientHeight || cv.parentNode.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function draw(now){
      var t = now - t0;
      var g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#0a0907"); g.addColorStop(.55, "#17120a"); g.addColorStop(1, "#2a1f0b");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // a soft glow that drifts across
      var gx = w * (.55 + .25 * Math.sin(t * .00006)), gy = h * .55;
      var rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * .55);
      rg.addColorStop(0, "rgba(232,196,104," + (o.dim ? .10 : .16) + ")"); rg.addColorStop(1, "rgba(232,196,104,0)");
      ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      var step = Math.max(6, Math.round(w / 140));
      for (var r = 0; r < RIBBONS.length; r++){
        var R = RIBBONS[r];
        for (var i = 0; i < R.lines; i++){
          var k = i / Math.max(1, R.lines - 1), off = (k - .5) * R.spread * h;
          var a = R.alpha * (.25 + .75 * Math.sin(Math.PI * k)) * (o.dim ? .55 : 1) / 2.4;
          ctx.beginPath();
          for (var x = 0; x <= w + step; x += step){
            var p = x / w;
            var y = R.y * h + off
              + Math.sin(p * Math.PI * R.len + t * R.speed * 6 + R.phase + k * .55) * R.amp * h
              + Math.sin(p * Math.PI * .7 - t * R.speed * 3 + R.phase) * R.amp * h * .5;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = "rgba(240,206,120," + a.toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
    function frame(now){
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - last < 33) return; // about 30 frames a second is plenty
      last = now;
      if (!w || !h) size();
      draw(now);
    }
    size();
    addEventListener("resize", size);
    if (reduce){ draw(t0 + 4000); } else raf = requestAnimationFrame(frame);
    return {
      stop: function(){ running = false; cancelAnimationFrame(raf); },
      start: function(){ if (!running && !reduce){ running = true; raf = requestAnimationFrame(frame); } },
      resize: size
    };
  }
  window.mpWaves = mpWaves;

  var boot = document.getElementById("boot"), bootWaves = null;
  if (boot){
    bootWaves = mpWaves(document.getElementById("boot-waves"));
    // Never leave anyone stuck on the boot screen.
    setTimeout(function(){ if (!boot.classList.contains("auth")) window.mpBoot("app"); }, 20000);
  }
  window.mpBoot = function(mode){
    if (!boot) return;
    if (mode === "auth"){ boot.classList.add("auth"); document.body.classList.add("boot-auth"); return; }
    if (boot.classList.contains("gone")) return;
    boot.classList.add("gone");
    document.body.classList.remove("boot-auth");
    setTimeout(function(){ if (bootWaves) bootWaves.stop(); boot.style.display = "none"; }, 700);
  };
})();
