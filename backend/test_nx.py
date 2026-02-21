import networkx as nx

G = nx.DiGraph()
edges = [
    {"source": "father", "target": "me", "label": "parent_of"},
    {"source": "mother", "target": "me", "label": "parent_of"},
    {"source": "me", "target": "node-2", "label": "parent_of"},
    {"source": "me", "target": "node-3", "label": "parent_of"}
]

# Simulate the exact parsing in inference.py
for e in edges:
    if e["label"] == "parent_of":
        G.add_edge(e["source"], e["target"], relation="parent_of")
    elif e["label"] == "spouse_of":
        G.add_edge(e["source"], e["target"], relation="spouse_of")
        G.add_edge(e["target"], e["source"], relation="spouse_of")

node_data = {
    "me": {"gender": "M"},
    "node-2": {"gender": "M"},
    "node-3": {"gender": "M"}
}

U = G.to_undirected()

try:
    path = nx.shortest_path(U, source="me", target="node-3")
    print("Shortest path me -> node-3:", path)

    signature = []
    for i in range(len(path)-1):
        u = path[i]
        v = path[i+1]
        if G.has_edge(v, u) and G[v][u]["relation"] == "parent_of":
            gender = node_data.get(v, {}).get("gender", "M")
            signature.append(f"parent({gender})")
        elif G.has_edge(u, v) and G.get_edge_data(u, v).get("relation") == "spouse_of":
            gender = node_data.get(v, {}).get("gender", "M")
            signature.append(f"spouse({gender})")
        elif G.has_edge(u, v) and G[u][v]["relation"] == "parent_of":
            gender = node_data.get(v, {}).get("gender", "M")
            signature.append(f"child({gender})")

    print("Signature me -> node-3:", tuple(signature))
except Exception as e:
    print("Error:", e)
