<svelte:head>
	<title>Política de privacitat · Kudi (Barrakudes de Begur)</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="info privacy">
	<h1>Política de privacitat</h1>

	<p>
		Som els <strong>Barrakudes de Begur</strong>, l'associació de joves de Begur (<a
			href="https://barrakudesbegur.org">barrakudesbegur.org</a
		>). En <strong>Kudi</strong> és el nostre assistent de WhatsApp. Per a qualsevol dubte sobre les
		teves dades, escriu-nos a
		<a href="mailto:hola@barrakudesbegur.org">hola@barrakudesbegur.org</a>.
	</p>

	<section>
		<h2>Quines dades recollim</h2>
		<ul>
			<li>
				<strong>WhatsApp (en Kudi):</strong> el teu número de telèfon, el nom del teu perfil de WhatsApp
				i els missatges que intercanvies amb en Kudi.
			</li>
		</ul>
	</section>

	<section>
		<h2>Per a què les fem servir</h2>
		<ul>
			<li>Per respondre't i ajudar-te amb coses dels Barrakudes.</li>
			<li>Per avisar-te de novetats de l'associació quan hi hagi.</li>
		</ul>
		<p>
			Res més: ni publicitat, ni cedir-les a tercers, ni vendre-les. La base legal és el teu
			consentiment — escriure voluntàriament a en Kudi.
		</p>
	</section>

	<section>
		<h2>On es guarden</h2>
		<p>
			A la nostra base de dades, sobre infraestructura de Cloudflare. Les converses passen per
			WhatsApp (Meta), com qualsevol altre xat de WhatsApp. Quan en Kudi fa servir intel·ligència
			artificial per entendre un missatge, el missatge es processa a Cloudflare i no s'utilitza per
			entrenar cap model.
		</p>
	</section>

	<section>
		<h2>Quant de temps</h2>
		<p>
			Mantenim la conversa de WhatsApp per poder respondre i processar amb coherència els missatges
			que ens enviïs. Pots demanar-nos que l'esborrem quan vulguis.
		</p>
	</section>

	<section>
		<h2>Els teus drets</h2>
		<p>
			Pots demanar-nos veure, corregir o esborrar les teves dades quan vulguis (drets d'accés,
			rectificació, supressió i oposició). Escriu-nos a
			<a href="mailto:hola@barrakudesbegur.org">hola@barrakudesbegur.org</a>.
		</p>
	</section>

	<section>
		<h2>Codi obert</h2>
		<p>
			En Kudi és codi lliure: pots veure exactament què fem amb les dades al
			<a href="https://github.com/barrakudesbegur/whatsapp-bot">codi font del bot</a>.
		</p>
	</section>

	<p class="updated">Última actualització: 8 de juliol de 2026</p>
</main>

<style>
	.privacy {
		display: flex;
		flex-direction: column;
		gap: 1.4rem;
	}
	.privacy h1 {
		margin-bottom: 0.2rem;
	}
	.privacy section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.privacy h2 {
		font-size: 1.4rem;
	}
	.privacy ul {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-left: 1.2rem;
		margin: 0;
	}
	.privacy .updated {
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
