#!/usr/bin/env python3
"""
Side-by-side evaluation: base model vs fine-tuned model.
Runs 15 test prompts and prints comparison for human review.
No auto-score -- requires human approval before deploy.

Usage:
    python scripts/evaluate_model.py --ft-model ft:gpt-4o-mini-...
    python scripts/evaluate_model.py --ft-model ft:gpt-4o-mini-... --base-model gpt-4o-mini
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))
from dotenv import load_dotenv
load_dotenv()

import openai

client = openai.AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

SYSTEM_BASE = """Sos Charlott, una asesora inmobiliaria virtual de una empresa en Rosario, Argentina.
Tu objetivo es ayudar a los clientes a encontrar propiedades para comprar o alquilar.
Respondés siempre en español rioplatense, de forma cálida, directa y profesional.
No sos un chatbot genérico — sos una asesora experta que conoce el mercado."""

SYSTEM_FT = "Sos Charlott, asesora inmobiliaria de Rosario, Argentina. Respondés en espanol rioplatense, de forma calida y directa."

TEST_CASES = [
    {"label": "Saludo simple", "messages": [
        {"role": "user", "content": "Hola"},
    ]},
    {"label": "Saludo con nombre", "messages": [
        {"role": "user", "content": "Buenas, me llamo Carlos"},
    ]},
    {"label": "Busqueda directa", "messages": [
        {"role": "user", "content": "Busco departamento 2 ambientes en Rosario hasta 90 mil dolares"},
    ]},
    {"label": "Busqueda sin presupuesto", "messages": [
        {"role": "user", "content": "Quiero 3 ambientes en Funes"},
    ]},
    {"label": "Pregunta por zona", "messages": [
        {"role": "user", "content": "Que tienen en Pichincha?"},
    ]},
    {"label": "Monoambiente alquiler", "messages": [
        {"role": "user", "content": "Busco monoambiente para alquilar en el centro"},
    ]},
    {"label": "Ambiguedad operacion", "messages": [
        {"role": "user", "content": "Necesito un departamento en Belgrano"},
    ]},
    {"label": "Presupuesto en pesos", "messages": [
        {"role": "user", "content": "Tengo hasta 50 millones de pesos"},
    ]},
    {"label": "Cliente indeciso", "messages": [
        {"role": "user", "content": "No se bien que quiero, algo lindo en Rosario"},
    ]},
    {"label": "Pregunta sobre precios mercado", "messages": [
        {"role": "user", "content": "Como esta el mercado ahora, vale la pena comprar?"},
    ]},
    {"label": "Fuera de scope", "messages": [
        {"role": "user", "content": "Necesito un abogado para hacer un contrato"},
    ]},
    {"label": "Pregunta quien es", "messages": [
        {"role": "user", "content": "Con quien hablo?"},
    ]},
    {"label": "Pide visita", "messages": [
        {"role": "user", "content": "Quiero ver el departamento de Corrientes 1200"},
    ]},
    {"label": "Mascotas", "messages": [
        {"role": "user", "content": "Tienen propiedades que acepten perros grandes?"},
    ]},
    {"label": "Multi-turn refinamiento", "messages": [
        {"role": "user", "content": "Hola busco algo"},
        {"role": "assistant", "content": "Hola! Para comprar o alquilar?"},
        {"role": "user", "content": "Para comprar, en Rosario, con 2 ambientes"},
    ]},
]


async def get_reply(model: str, system: str, messages: list) -> str:
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}] + messages,
            max_tokens=300,
            temperature=0.7,
        )
        return resp.choices[0].message.content or "(empty)"
    except Exception as e:
        return f"ERROR: {e}"


async def run_test(case: dict, base_model: str, ft_model: str) -> dict:
    base_reply, ft_reply = await asyncio.gather(
        get_reply(base_model, SYSTEM_BASE, case["messages"]),
        get_reply(ft_model, SYSTEM_FT, case["messages"]),
    )
    return {
        "label": case["label"],
        "prompt": case["messages"][-1]["content"],
        "base": base_reply,
        "ft": ft_reply,
    }


def print_comparison(results: list, base_model: str, ft_model: str):
    sep = "=" * 80
    print(f"\n{sep}")
    print(f"MODEL COMPARISON")
    print(f"  Base: {base_model}")
    print(f"  FT:   {ft_model}")
    print(sep)

    for i, r in enumerate(results, 1):
        print(f"\n[{i:02d}] {r['label']}")
        print(f"  INPUT: {r['prompt']}")
        print(f"\n  BASE MODEL:")
        for line in r["base"].split("\n"):
            print(f"    {line}")
        print(f"\n  FINE-TUNED:")
        for line in r["ft"].split("\n"):
            print(f"    {line}")
        print(f"\n  {'-'*60}")

    print(f"\n{sep}")
    print("Review the outputs above and decide if the FT model is ready.")
    print("If yes: python scripts/run_finetuning.py deploy <ft_model>")
    print(sep)


async def main_async(args):
    print(f"[eval] Running {len(TEST_CASES)} test cases...")
    print(f"[eval] Base model: {args.base_model}")
    print(f"[eval] FT model:   {args.ft_model}")
    print(f"[eval] (Running in parallel, please wait...)\n")

    tasks = [run_test(case, args.base_model, args.ft_model) for case in TEST_CASES]
    results = await asyncio.gather(*tasks)

    print_comparison(results, args.base_model, args.ft_model)

    # Save results to file for later reference
    output = BASE_DIR / "data" / "evaluation_results.json"
    with open(output, "w", encoding="utf-8") as f:
        json.dump({
            "base_model": args.base_model,
            "ft_model": args.ft_model,
            "results": results,
        }, f, ensure_ascii=False, indent=2)
    print(f"\n[eval] Results saved to {output}")


def main():
    parser = argparse.ArgumentParser(description="Side-by-side model evaluation")
    parser.add_argument("--ft-model", required=True, help="Fine-tuned model ID (ft:gpt-4o-mini-...)")
    parser.add_argument("--base-model", default="gpt-4o-mini", help="Base model to compare against")
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
