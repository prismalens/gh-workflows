import os
import sys
import re
import tomllib

def check_routes():
    wrangler_path = 'worker/wrangler.toml'
    index_path = 'worker/index.js'
    
    # 1. Parse wrangler.toml
    with open(wrangler_path, 'rb') as f:
        config = tomllib.load(f)
    
    # Try to find run_worker_first
    run_worker_first = config.get('env', {}).get('production', {}).get('run_worker_first', [])
    if not run_worker_first:
        # Check root level
        for route_obj in config.get('routes', []):
            if 'pattern' in route_obj and isinstance(route_obj, dict):
                pass
        
        # In case the parsing is different depending on toml structure
        with open(wrangler_path, 'r') as f:
            content = f.read()
            match = re.search(r'run_worker_first\s*=\s*\[(.*?)\]', content)
            if match:
                patterns_str = match.group(1)
                run_worker_first = [p.strip().strip('"\'') for p in patterns_str.split(',') if p.strip()]

    print(f"Configured run_worker_first routes: {run_worker_first}")

    # 2. Parse index.js to find POST routes
    post_routes = set()
    with open(index_path, 'r') as f:
        content = f.read()
        
        # Look for POST method checks
        # e.g., method === "POST" && (pathname === "/ingest" || pathname === "/")
        # e.g., method === "POST" && pathname === "/pr-state"
        # e.g., method === "POST" && pathname.startsWith("/ingest/findings")
        
        lines = content.split('\n')
        for line in lines:
            if 'method === "POST"' in line or "method === 'POST'" in line:
                # Extract pathnames
                matches = re.findall(r'pathname\s*===\s*["\']([^"\']+)["\']', line)
                for m in matches:
                    post_routes.add(m)
                
                starts_with_matches = re.findall(r'pathname\.startsWith\s*\(\s*["\']([^"\']+)["\']\s*\)', line)
                for m in starts_with_matches:
                    # Approximation: if it starts with this, treat the base path as the route for matching
                    post_routes.add(m)

    print(f"Found POST routes in index.js: {sorted(list(post_routes))}")

    # Ensure known routes are present (fallback if regex missed something)
    expected_routes = ['/', '/ingest', '/pr-state', '/ingest/findings', '/api/changes']
    for r in expected_routes:
        if r not in post_routes and any(p in content for p in [r]): # rough check if it's in the file
             post_routes.add(r)

    # 3. Check coverage
    failed = False
    for route in post_routes:
        covered = False
        for pattern in run_worker_first:
            if pattern == route:
                covered = True
                break
            elif pattern.endswith('/*'):
                base = pattern[:-2]
                if route == base or route.startswith(base + '/'):
                    covered = True
                    break
            elif pattern == '/' and route == '/':
                covered = True
                break
                
        if not covered:
            print(f"ERROR: POST route '{route}' is not covered by any run_worker_first pattern!")
            failed = True

    if failed:
        sys.exit(1)
    
    print("SUCCESS: All POST routes are covered.")

if __name__ == "__main__":
    check_routes()
